import type { CoverEngine } from "./cover.svelte";
import { PlayerMediaSession } from "./media-session";
import type { QueueEngine } from "./queue.svelte";
import type { MemoryView } from "./memory.svelte";
import type { TrackEngine } from "./track.svelte";

const interactive =
  'input, textarea, select, summary, audio, video, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="textbox"]';

function installPlaybackShortcuts(toggle: () => void, root: Document = document) {
  const keydown = (event: KeyboardEvent) => {
    if (
      event.key !== " " ||
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if (
      event
        .composedPath()
        .some((target) => target instanceof Element && target.closest(interactive))
    )
      return;
    event.preventDefault();
    if (!event.repeat) toggle();
  };
  root.addEventListener("keydown", keydown);
  return () => root.removeEventListener("keydown", keydown);
}

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "buffering"
  | "seeking"
  | "ended"
  | "error";
export interface PlaybackEngineOptions {
  queue: Pick<
    QueueEngine,
    "select" | "setPosition" | "save" | "flush" | "subscribe" | "setPlaybackActive"
  >;
  memory: Pick<
    MemoryView,
    | "tracks"
    | "albums"
    | "artists"
    | "queueTracks"
    | "queueIndex"
    | "queuePosition"
    | "trackArtwork"
    | "images"
  >;
  tracks: Pick<TrackEngine, "getSource" | "releaseSource">;
  covers: Pick<CoverEngine, "ensureTrackCover" | "subscribe">;
  mediaSession?: MediaSession;
  createAudio?: () => HTMLAudioElement;
  isAvailable?: (id: string) => boolean;
}

export class PlaybackEngine {
  #queue: PlaybackEngineOptions["queue"];
  #memory: PlaybackEngineOptions["memory"];
  #tracks: PlaybackEngineOptions["tracks"];
  #covers: PlaybackEngineOptions["covers"];
  #nativeSession?: MediaSession;
  #media?: PlayerMediaSession;
  #audio?: HTMLAudioElement;
  #createAudio: () => HTMLAudioElement;
  #isAvailable: (id: string) => boolean;
  #cleanup?: () => void;
  #duration = $state(0);
  #offset = 0;
  #playing = $state(false);
  #intent = false;
  #status = $state<PlaybackStatus>("idle");
  #error = $state.raw<unknown>();
  #id?: string;
  #cached = false;
  #nativeSeeking = false;
  #forced = false;
  #generation = 0;
  #abort?: AbortController;
  #lastSave = 0;
  #metadataKey = "";

  constructor(options: PlaybackEngineOptions) {
    this.#queue = options.queue;
    this.#memory = options.memory;
    this.#tracks = options.tracks;
    this.#covers = options.covers;
    this.#nativeSession = options.mediaSession;
    this.#createAudio = options.createAudio ?? (() => new Audio());
    this.#isAvailable = options.isAvailable ?? (() => true);
  }

  #canPlay(index: number) {
    const id = this.#memory.queueTracks[index];
    return id !== undefined && !!this.#memory.tracks.get(id) && this.#isAvailable(id);
  }

  #nextIndex(after: number) {
    return this.#memory.queueTracks.findIndex(
      (_id, index) => index > after && this.#canPlay(index),
    );
  }

  #previousIndex() {
    for (let index = this.#memory.queueIndex - 1; index >= 0; index--) {
      if (this.#canPlay(index)) return index;
    }
    return -1;
  }

  get track() {
    const current = this.#memory.queueTracks[this.#memory.queueIndex];
    return current ? this.#memory.tracks.get(current) : undefined;
  }
  get position() {
    return this.#memory.queuePosition;
  }
  get duration() {
    return this.#duration > 0 ? this.#duration : (this.track?.duration ?? 0);
  }
  get playing() {
    return this.#playing;
  }
  get status() {
    return this.#status;
  }
  get error() {
    return this.#error;
  }
  get hasNext() {
    return this.#memory.queueIndex >= 0 && this.#nextIndex(this.#memory.queueIndex) >= 0;
  }
  get hasPrevious() {
    return this.#previousIndex() >= 0;
  }

  #syncMediaSession() {
    this.#media?.setPlaybackState(!this.track ? "none" : this.#playing ? "playing" : "paused");
    this.#media?.setNavigation(
      this.hasNext,
      this.hasPrevious || (!!this.track && this.position > 0),
    );
    this.#media?.setPosition(this.duration, this.position, this.#audio?.playbackRate);
  }

  get artworkId() {
    const track = this.track;
    if (!track) return undefined;
    const candidates = this.#memory.trackArtwork.get(track.id) ?? [];
    return candidates.find((id) => this.#memory.images.has(id)) ?? candidates[0];
  }

  #artwork = () => {
    const selected = this.track;
    const track = selected && {
      id: selected.id,
      title: selected.title,
      artist: this.#memory.artists.get(selected.artistId)?.name ?? "Unknown artist",
      album: this.#memory.albums.get(selected.albumId)?.title ?? "Unknown album",
    };
    const source = selected
      ? this.#covers.ensureTrackCover(selected.id, { allowNetwork: false }).source
      : undefined;
    const key = JSON.stringify([track?.id, track?.title, track?.artist, track?.album, source]);
    if (this.#metadataKey === key) return;
    this.#metadataKey = key;
    this.#media?.setMetadata(track, source);
  };

  #invalidate() {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = undefined;
  }

  #unload() {
    this.#queue.setPlaybackActive(false);
    this.#invalidate();
    this.#intent = false;
    this.#audio?.pause();
    this.#audio?.removeAttribute("src");
    this.#audio?.load();
    this.#tracks.releaseSource();
    this.#cached = false;
    this.#forced = false;
    this.#playing = false;
    this.#duration = 0;
    this.#offset = 0;
    this.#status = "idle";
  }

  #queueChanged = () => {
    const id = this.track?.id;
    if (id !== this.#id) {
      this.#id = id;
      this.#unload();
      this.#error = undefined;
    }
    this.#artwork();
    this.#syncMediaSession();
  };

  mount() {
    this.#cleanup?.();
    const audio = this.#createAudio();
    audio.preload = "metadata";
    this.#audio = audio;
    this.#metadataKey = "";
    this.#media = new PlayerMediaSession(
      {
        play: () => {
          void this.play();
        },
        pause: () => this.pause(),
        next: () => {
          void this.next();
        },
        previous: () => {
          void this.previous();
        },
        seek: (position) => {
          void this.seek(position);
        },
      },
      this.#nativeSession,
    );
    const onTime = () => {
      if (!audio.currentSrc) return;
      this.#queue.setPosition(
        this.#offset + (Number.isFinite(audio.currentTime) ? audio.currentTime : 0),
      );
      if (this.#intent && Date.now() - this.#lastSave >= 10_000) {
        this.#lastSave = Date.now();
        this.#queue.flush();
      }
    };
    const onMetadata = () => {
      this.#duration =
        this.#offset > 0
          ? (this.track?.duration ??
            (Number.isFinite(audio.duration) ? this.#offset + audio.duration : 0))
          : Number.isFinite(audio.duration)
            ? audio.duration
            : 0;
      this.#syncMediaSession();
    };
    const events: Record<string, () => void> = {
      timeupdate: onTime,
      loadedmetadata: onMetadata,
      durationchange: onMetadata,
      ratechange: () => this.#syncMediaSession(),
      playing: () => {
        if (!this.#intent) {
          audio.pause();
          return;
        }
        this.#playing = true;
        this.#status = "ready";
        this.#syncMediaSession();
      },
      pause: () => {
        this.#playing = false;
        this.#syncMediaSession();
      },
      waiting: () => {
        if (this.#intent && this.#status === "ready") this.#status = "buffering";
        this.#syncMediaSession();
      },
      canplay: () => {
        if (this.#status === "buffering") this.#status = "ready";
        this.#syncMediaSession();
      },
      ended: () => {
        if (!audio.currentSrc || !this.#intent) return;
        if (this.hasNext) void this.next();
        else {
          this.#intent = false;
          this.#playing = false;
          this.#status = "ended";
          this.#queue.flush();
          this.#syncMediaSession();
        }
      },
      error: () => {
        if (!audio.currentSrc || this.#status === "loading" || this.#status === "seeking") return;
        if (audio.error?.code === 4 && !this.#forced) {
          void this.#load(this.position, this.#intent, true);
        } else this.#fail(new Error(audio.error?.message || "The track could not be played."));
      },
    };
    for (const [event, handler] of Object.entries(events)) audio.addEventListener(event, handler);
    const removeShortcuts = installPlaybackShortcuts(() => {
      void this.toggle();
    });
    const unsubscribeQueue = this.#queue.subscribe(this.#queueChanged);
    const unsubscribeCovers = this.#covers.subscribe(this.#artwork);
    const hidden = () => {
      if (document.visibilityState === "hidden") this.#queue.flush();
    };
    document.addEventListener("visibilitychange", hidden);
    this.#queueChanged();
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      removeShortcuts();
      unsubscribeQueue();
      unsubscribeCovers();
      document.removeEventListener("visibilitychange", hidden);
      for (const [event, handler] of Object.entries(events))
        audio.removeEventListener(event, handler);
      this.#queue.flush();
      this.#unload();
      this.#media?.destroy();
      this.#media = undefined;
      this.#audio = undefined;
      this.#id = undefined;
      this.#cleanup = undefined;
      this.#syncMediaSession();
    };
    this.#cleanup = cleanup;
    return cleanup;
  }

  #fail(error: unknown) {
    this.#invalidate();
    this.#intent = false;
    this.#audio?.pause();
    this.#error = error;
    this.#status = "error";
    this.#intent = false;
    this.#playing = false;
    this.#syncMediaSession();
  }

  #metadata(audio: HTMLAudioElement, signal: AbortSignal) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", loaded);
        audio.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new DOMException("The audio format is unsupported.", "NotSupportedError"));
      };
      const aborted = () => {
        cleanup();
        reject(new DOMException("Playback cancelled.", "AbortError"));
      };
      audio.addEventListener("loadedmetadata", loaded);
      audio.addEventListener("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  async #load(position: number, autoplay: boolean, forceTranscode = false, seeking = false) {
    const audio = this.#audio;
    const track = this.track;
    if (!audio || !track || !this.#canPlay(this.#memory.queueIndex)) return;
    this.#queue.setPlaybackActive(true);
    this.#id = track.id;
    this.#artwork();
    const download = {
      id: track.id,
      title: track.title,
      artist: this.#memory.artists.get(track.artistId)?.name,
      album: this.#memory.albums.get(track.albumId)?.title,
      contentType: track.mimeType,
      coverArt: this.artworkId,
    };
    this.#invalidate();
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#intent = autoplay;
    audio.pause();
    this.#error = undefined;
    this.#status = seeking ? "seeking" : "loading";
    this.#syncMediaSession();
    const valid = () => generation === this.#generation && this.#audio === audio;
    const prepare = async (transcode: boolean) => {
      const source = await this.#tracks.getSource(download, {
        forceTranscode: transcode,
        position,
      });
      if (!valid()) return;
      this.#cached = source.cached;
      this.#nativeSeeking = source.nativeSeeking ?? false;
      this.#offset = source.offset ?? 0;
      this.#duration = 0;
      this.#forced = transcode || this.#offset > 0;
      audio.src = source.url;
      if (position > 0) {
        await this.#metadata(audio, abort.signal);
        if (!valid()) return;
        audio.currentTime = Math.min(
          Math.max(0, position - this.#offset),
          Number.isFinite(audio.duration) ? audio.duration : position,
        );
        this.#queue.setPosition(this.#offset + audio.currentTime);
      }
      if (autoplay && this.#intent) await audio.play();
      if (!valid()) return;
      this.#status = "ready";
      this.#playing = !audio.paused;
    };
    try {
      try {
        await prepare(forceTranscode);
      } catch (error) {
        if (!valid()) return;
        if (
          forceTranscode ||
          !(error instanceof Error) ||
          !(error.name === "NotSupportedError" || /supported sources/i.test(error.message))
        )
          throw error;
        await prepare(true);
      }
      if (!valid()) return;
      this.#queue.save();
      this.#syncMediaSession();
    } catch (error) {
      if (valid()) this.#fail(error);
    }
  }

  async play() {
    if (!this.#audio) return;
    if (!this.#canPlay(this.#memory.queueIndex)) {
      await this.playIndex(this.#nextIndex(-1));
      return;
    }
    if (!this.track) return;
    if (this.#status === "loading" || this.#status === "seeking") {
      await this.#load(this.position, true, this.#forced, this.#status === "seeking");
      return;
    }
    if (!this.#audio.currentSrc || this.#status === "error" || this.#status === "ended") {
      await this.#load(this.#status === "ended" ? 0 : this.position, true);
      return;
    }
    this.#intent = true;
    const generation = this.#generation;
    try {
      await this.#audio.play();
    } catch (error) {
      if (generation === this.#generation) this.#fail(error);
    }
  }

  pause() {
    this.#invalidate();
    this.#intent = false;
    this.#audio?.pause();
    if (this.#status === "loading" || this.#status === "seeking") {
      this.#audio?.removeAttribute("src");
      this.#audio?.load();
      this.#tracks.releaseSource();
      this.#cached = false;
    }
    this.#playing = false;
    this.#status = this.track ? "ready" : "idle";
    this.#queue.flush();
    this.#syncMediaSession();
  }

  async toggle() {
    if (this.#intent) this.pause();
    else await this.play();
  }

  async playIndex(index: number) {
    if (!Number.isInteger(index) || !this.#canPlay(index)) return;
    this.#queue.select(index);
    await this.#load(0, true);
  }

  async next() {
    if (this.hasNext) await this.playIndex(this.#nextIndex(this.#memory.queueIndex));
  }
  async previous() {
    if (this.#canPlay(this.#memory.queueIndex) && (this.position > 3 || !this.hasPrevious))
      await this.seek(0);
    else if (this.hasPrevious) await this.playIndex(this.#previousIndex());
  }

  async seek(position: number) {
    if (!Number.isFinite(position) || !this.#audio || !this.#canPlay(this.#memory.queueIndex))
      return;
    const duration = this.duration;
    position = Math.max(0, duration > 0 ? Math.min(position, duration) : position);
    const audio = this.#audio;
    const contains = (ranges: TimeRanges) => {
      const relative = position - this.#offset;
      for (let i = 0; i < ranges.length; i++) {
        if (relative >= ranges.start(i) && relative <= ranges.end(i)) return true;
      }
      return false;
    };
    const buffered = contains(audio.buffered);
    const seekable = this.#nativeSeeking && contains(audio.seekable);
    if (
      audio.currentSrc &&
      (this.#cached || buffered || seekable) &&
      this.#status !== "loading" &&
      this.#status !== "seeking"
    ) {
      try {
        audio.currentTime = position - this.#offset;
        this.#queue.setPosition(position);
        this.#queue.save();
        this.#syncMediaSession();
        return;
      } catch (error) {
        if (this.#cached) {
          this.#fail(error);
          return;
        }
        // A server/browser may reject a seek despite advertising a range.
      }
    }
    const resume = this.#intent;
    this.#queue.setPosition(position);
    await this.#load(position, resume, false, true);
  }

  suspendNetwork() {
    if (!this.#cached || this.#status === "loading" || this.#status === "seeking") this.suspend();
    else this.#syncMediaSession();
  }

  suspend() {
    this.#unload();
    this.#error = undefined;
    this.#syncMediaSession();
  }

  stop() {
    this.#unload();
    this.#error = undefined;
    this.#queue.select(-1);
    this.#syncMediaSession();
  }

  destroy() {
    this.#cleanup?.();
  }
}
