import type { CoverEngine } from "./cover.svelte";
import { untrack } from "svelte";
import type { QueueEngine } from "./queue.svelte";
import type { CacheSelection } from "./cache.svelte";
import type Player from "./player.svelte";
import type { PlayerTrack } from "./player.svelte";
import type { TrackEngine } from "./track.svelte";

const emptyQueue = { tracks: [] as readonly string[], index: -1, position: 0 };

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

interface PlaybackEngineOptions {
  queue: Pick<
    QueueEngine,
    "select" | "setPosition" | "save" | "flush" | "subscribe" | "setPlaybackActive"
  >;
  selection: CacheSelection;
  tracks: Pick<TrackEngine, "getSource" | "releaseSource">;
  covers: Pick<CoverEngine, "ensureTrackCover" | "subscribe">;
  isAvailable?: (id: string) => boolean;
}

export class PlaybackEngine {
  #queue: PlaybackEngineOptions["queue"];
  #selection: PlaybackEngineOptions["selection"];
  #covers: PlaybackEngineOptions["covers"];
  #options: PlaybackEngineOptions;
  #player = $state.raw<ReturnType<typeof Player>>();
  #isAvailable: (id: string) => boolean;
  #cleanup?: () => void;
  #id?: string;
  #lastSave = 0;
  #cached = false;
  #sourceRequest = 0;
  #command = 0;

  constructor(options: PlaybackEngineOptions) {
    this.#options = options;
    this.#queue = options.queue;
    this.#selection = options.selection;
    this.#covers = options.covers;
    this.#isAvailable = options.isAvailable ?? (() => true);
  }

  get #localQueue() {
    return this.#selection.cache?.queue ?? emptyQueue;
  }

  #canPlay(index: number) {
    const id = this.#localQueue.tracks[index];
    return id !== undefined && !!this.#selection.cache?.tracks.get(id) && this.#isAvailable(id);
  }

  #nextIndex(after: number) {
    return this.#localQueue.tracks.findIndex((_id, index) => index > after && this.#canPlay(index));
  }

  #previousIndex() {
    for (let index = this.#localQueue.index - 1; index >= 0; index--) {
      if (this.#canPlay(index)) return index;
    }
    return -1;
  }

  get track() {
    const current = this.#localQueue.tracks[this.#localQueue.index];
    return current ? this.#selection.cache?.tracks.get(current) : undefined;
  }
  get position() {
    return this.#localQueue.position;
  }
  get duration() {
    return this.#player?.duration || this.track?.duration || 0;
  }
  get playing() {
    return this.#player?.playing ?? false;
  }
  get status() {
    return this.#player?.status ?? "idle";
  }
  get error() {
    return this.#player?.error;
  }
  get hasNext() {
    return this.#localQueue.index >= 0 && this.#nextIndex(this.#localQueue.index) >= 0;
  }
  get hasPrevious() {
    return this.#previousIndex() >= 0;
  }

  #queueChanged = () => {
    const id = this.track?.id;
    if (id !== this.#id) {
      this.#id = id;
      this.suspend();
    }
  };

  setPosition(position: number) {
    if (!this.#player) return;
    this.#queue.setPosition(position);
    if (!this.playing) this.#queue.save();
    else if (Date.now() - this.#lastSave >= 10_000) {
      this.#lastSave = Date.now();
      void this.#queue.flush();
    }
  }

  ended() {
    if (!this.#player) return;
    this.#queue.setPlaybackActive(false);
    if (this.hasNext) void this.next();
    else void this.#queue.flush();
  }

  mount(player: ReturnType<typeof Player>) {
    this.#cleanup?.();
    this.#player = player;
    const stopEffects = $effect.root(() => {
      $effect(() => {
        const status = player.status;
        const playing = player.playing;
        // Includes controls invoked by Media Session, not just app commands.
        untrack(() => {
          if (playing || status === "loading" || status === "seeking")
            this.#queue.setPlaybackActive(true);
          if (status === "ready") {
            if (playing) this.#queue.save();
            else void this.#queue.flush();
          }
        });
      });
    });
    const removeShortcuts = installPlaybackShortcuts(() => {
      void this.toggle();
    });
    const unsubscribeQueue = this.#queue.subscribe(this.#queueChanged);
    const hidden = () => {
      if (document.visibilityState === "hidden") void this.#queue.flush();
    };
    document.addEventListener("visibilitychange", hidden);
    this.#queueChanged();
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      stopEffects();
      removeShortcuts();
      unsubscribeQueue();
      document.removeEventListener("visibilitychange", hidden);
      void this.#queue.flush();
      this.suspend();
      this.#player = undefined;
      this.#id = undefined;
      this.#cleanup = undefined;
    };
    this.#cleanup = cleanup;
    return cleanup;
  }

  #playerTrack(): PlayerTrack | undefined {
    const track = this.track;
    if (!track || !this.#canPlay(this.#localQueue.index)) return;
    const descriptor = {
      id: track.id,
      title: track.title,
      artist: this.#selection.cache?.artists.get(track.artistId)?.name,
      album: this.#selection.cache?.albums.get(track.albumId)?.title,
      contentType: track.mimeType,
    };
    return {
      metadata: {
        title: descriptor.title,
        artist: descriptor.artist,
        album: descriptor.album,
        duration: track.duration,
        artwork: this.#covers.ensureTrackCover(track.id, { allowNetwork: false }).source,
      },
      position: this.position,
      getSource: async ({ signal, ...options }) => {
        // TrackEngine owns one source slot. Scope cleanup to this request so a
        // late component result cannot release a newer request's object URL.
        const request = ++this.#sourceRequest;
        const release = () => {
          signal.removeEventListener("abort", release);
          if (request !== this.#sourceRequest) return;
          this.#sourceRequest++;
          this.#options.tracks.releaseSource();
        };
        signal.throwIfAborted();
        signal.addEventListener("abort", release, { once: true });
        try {
          const source = await this.#options.tracks.getSource(descriptor, options);
          signal.throwIfAborted();
          if (request !== this.#sourceRequest)
            throw new DOMException("Source superseded.", "AbortError");
          signal.removeEventListener("abort", release);
          this.#cached = source.cached;
          return {
            url: source.url,
            offset: source.offset,
            seekMode: source.cached ? "full" : source.nativeSeeking ? "seekable" : "buffered",
            release,
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    };
  }

  async play() {
    if (!this.#player) return;
    if (!this.#canPlay(this.#localQueue.index)) {
      await this.playIndex(this.#nextIndex(-1));
      return;
    }
    const command = ++this.#command;
    this.#queue.setPlaybackActive(true);
    if (this.#player.status !== "idle") await this.#player.resume();
    else {
      const track = this.#playerTrack();
      if (!track) return;
      this.#id = this.track?.id;
      await this.#player.play(track);
    }
    if (command === this.#command) this.#queue.save();
  }
  pause() {
    this.#command++;
    this.#player?.pause();
    void this.#queue.flush();
  }
  async toggle() {
    if (this.playing || ["loading", "buffering", "seeking"].includes(this.status)) this.pause();
    else await this.play();
  }
  async playIndex(index: number) {
    if (!Number.isInteger(index) || !this.#canPlay(index)) return;
    this.#queue.select(index);
    this.suspend();
    await this.play();
  }

  async next() {
    if (this.hasNext) await this.playIndex(this.#nextIndex(this.#localQueue.index));
  }
  async previous() {
    if (this.#canPlay(this.#localQueue.index) && (this.position > 3 || !this.hasPrevious))
      await this.seek(0);
    else if (this.hasPrevious) await this.playIndex(this.#previousIndex());
  }

  async seek(position: number) {
    if (!Number.isFinite(position) || !this.#canPlay(this.#localQueue.index)) return;
    const command = ++this.#command;
    if (this.status === "idle") {
      // No track has been supplied to Player yet. Seeking a restored queue only
      // changes its resume point; it must not start audio or fetch a source.
      this.#queue.setPosition(
        Math.max(0, this.duration > 0 ? Math.min(position, this.duration) : position),
      );
    } else await this.#player?.seek(position);
    if (command === this.#command) this.#queue.save();
  }
  suspendNetwork() {
    if (!this.#cached || this.status === "loading" || this.status === "seeking") this.suspend();
  }
  suspend() {
    this.#command++;
    this.#player?.unload();
    this.#cached = false;
    this.#queue.setPlaybackActive(false);
  }
  stop() {
    this.suspend();
    this.#queue.select(-1);
  }
  destroy() {
    this.#cleanup?.();
  }
}
