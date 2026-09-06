import { createSubscriber } from "svelte/reactivity";
import type { CoverEngine } from "./cover-engine";
import { PlayerMediaSession } from "./media-session";
import type { QueueEngine } from "./queue-engine";
import type { TrackEngine } from "./track-engine";

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
  queue: QueueEngine;
  tracks: Pick<TrackEngine, "getSource" | "cache" | "releaseSource">;
  covers: Pick<CoverEngine, "getCover" | "subscribe">;
  mediaSession?: MediaSession;
  createAudio?: () => HTMLAudioElement;
}

export class PlaybackEngine {
  #queue: QueueEngine;
  #tracks: PlaybackEngineOptions["tracks"];
  #covers: PlaybackEngineOptions["covers"];
  #nativeSession?: MediaSession;
  #media?: PlayerMediaSession;
  #audio?: HTMLAudioElement;
  #createAudio: () => HTMLAudioElement;
  #cleanup?: () => void;
  #duration = 0;
  #playing = false;
  #intent = false;
  #status: PlaybackStatus = "idle";
  #error: unknown;
  #id?: string;
  #cached = false;
  #forced = false;
  #generation = 0;
  #abort?: AbortController;
  #lastSave = 0;
  #metadataKey = "";
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  constructor(options: PlaybackEngineOptions) {
    this.#queue = options.queue;
    this.#tracks = options.tracks;
    this.#covers = options.covers;
    this.#nativeSession = options.mediaSession;
    this.#createAudio = options.createAudio ?? (() => new Audio());
  }

  get track() {
    this.#subscribe();
    return this.#queue.tracks[this.currentIndex];
  }
  get currentIndex() {
    this.#subscribe();
    return this.#queue.tracks.findIndex((track) => track.id === this.#queue.current);
  }
  get position() {
    this.#subscribe();
    return this.#queue.position;
  }
  get duration() {
    this.#subscribe();
    return this.#duration;
  }
  get playing() {
    this.#subscribe();
    return this.#playing;
  }
  get status() {
    this.#subscribe();
    return this.#status;
  }
  get error() {
    this.#subscribe();
    return this.#error;
  }
  get hasNext() {
    this.#subscribe();
    return this.currentIndex >= 0 && this.currentIndex + 1 < this.#queue.tracks.length;
  }
  get hasPrevious() {
    this.#subscribe();
    return this.currentIndex > 0;
  }

  #publish() {
    this.#update();
    this.#media?.setPlaybackState(!this.track ? "none" : this.#playing ? "playing" : "paused");
    this.#media?.setNavigation(
      this.hasNext,
      this.hasPrevious || (!!this.track && this.position > 0),
    );
    this.#media?.setPosition(this.#duration, this.position, this.#audio?.playbackRate);
  }

  #artwork = () => {
    const track = this.track;
    const source = track?.coverArt
      ? this.#covers.getCover({
          candidates: [track.coverArt],
          allowNetwork: false,
        }).source
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
    this.#publish();
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
      this.#queue.setPosition(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
      if (this.#intent && Date.now() - this.#lastSave >= 10_000) {
        this.#lastSave = Date.now();
        this.#queue.flush();
      }
    };
    const onMetadata = () => {
      this.#duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      this.#publish();
    };
    const events: Record<string, () => void> = {
      timeupdate: onTime,
      loadedmetadata: onMetadata,
      durationchange: onMetadata,
      ratechange: () => this.#publish(),
      playing: () => {
        if (!this.#intent) {
          audio.pause();
          return;
        }
        this.#playing = true;
        this.#status = "ready";
        this.#publish();
      },
      pause: () => {
        this.#playing = false;
        this.#publish();
      },
      waiting: () => {
        if (this.#intent && this.#status === "ready") this.#status = "buffering";
        this.#publish();
      },
      canplay: () => {
        if (this.#status === "buffering") this.#status = "ready";
        this.#publish();
      },
      ended: () => {
        if (!audio.currentSrc || !this.#intent) return;
        if (this.hasNext) void this.next();
        else {
          this.#intent = false;
          this.#playing = false;
          this.#status = "ended";
          this.#queue.flush();
          this.#publish();
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
      this.#publish();
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
    this.#publish();
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
    if (!audio || !track) return;
    this.#invalidate();
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#intent = autoplay;
    audio.pause();
    this.#error = undefined;
    this.#status = seeking ? "seeking" : "loading";
    this.#publish();
    const valid = () => generation === this.#generation && this.#audio === audio;
    const prepare = async (transcode: boolean) => {
      let source;
      if (seeking) await this.#tracks.cache(track, { forceTranscode: true });
      if (!valid()) return;
      source = await this.#tracks.getSource(track, { forceTranscode: transcode });
      if (!valid()) return;
      if (!source.cached && position > 0) {
        await this.#tracks.cache(track, { forceTranscode: true });
        if (!valid()) return;
        source = await this.#tracks.getSource(track, { forceTranscode: true });
        transcode = true;
        if (!valid()) return;
      }
      this.#cached = source.cached;
      this.#forced = transcode;
      audio.src = source.url;
      if (position > 0) {
        await this.#metadata(audio, abort.signal);
        if (!valid()) return;
        audio.currentTime = Math.min(
          position,
          Number.isFinite(audio.duration) ? audio.duration : position,
        );
        this.#queue.setPosition(audio.currentTime);
      }
      if (autoplay && this.#intent) await audio.play();
      if (!valid()) return;
      this.#status = "ready";
      this.#playing = !audio.paused;
      if (!source.cached)
        void this.#tracks.cache(track, { forceTranscode: transcode }).catch(() => {});
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
      this.#publish();
    } catch (error) {
      if (valid()) this.#fail(error);
    }
  }

  async play() {
    if (!this.#audio) return;
    if (!this.track && this.#queue.tracks.length) {
      await this.playIndex(0);
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
    this.#publish();
  }

  async toggle() {
    if (this.#intent) this.pause();
    else await this.play();
  }

  async playIndex(index: number) {
    if (!Number.isInteger(index) || !this.#queue.tracks[index]) return;
    this.#queue.update({
      tracks: this.#queue.tracks,
      current: this.#queue.tracks[index].id,
      position: 0,
    });
    await this.#load(0, true);
  }

  async next() {
    if (this.hasNext) await this.playIndex(this.currentIndex + 1);
  }
  async previous() {
    if (!this.track) return;
    if (this.position > 3 || !this.hasPrevious) await this.seek(0);
    else await this.playIndex(this.currentIndex - 1);
  }

  async seek(position: number) {
    if (!Number.isFinite(position) || !this.#audio || !this.track) return;
    position = Math.max(0, this.#duration > 0 ? Math.min(position, this.#duration) : position);
    const audio = this.#audio;
    const buffered = Array.from(
      { length: audio.buffered.length },
      (_, i) => position >= audio.buffered.start(i) && position <= audio.buffered.end(i),
    ).some(Boolean);
    if (
      audio.currentSrc &&
      (this.#cached || buffered) &&
      this.#status !== "loading" &&
      this.#status !== "seeking"
    ) {
      try {
        audio.currentTime = position;
        this.#queue.setPosition(position);
        this.#queue.save();
        this.#publish();
      } catch (error) {
        this.#fail(error);
      }
    } else {
      const resume = this.#intent;
      this.#queue.setPosition(position);
      await this.#load(position, resume, true, true);
    }
  }

  stop() {
    this.#unload();
    this.#error = undefined;
    this.#queue.update({ tracks: this.#queue.tracks, position: 0 });
    this.#publish();
  }

  destroy() {
    this.#cleanup?.();
  }
}
