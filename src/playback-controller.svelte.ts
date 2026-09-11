import { untrack } from "svelte";
import type { CoverEngine } from "./cover.svelte";
import type { QueueEngine } from "./queue.svelte";
import type { CacheSelection } from "./cache.svelte";
import type Player from "./player.svelte";
import type { PlayerTrack } from "./player.svelte";
import type { TrackEngine } from "./track.svelte";

const emptyQueue = { tracks: [] as readonly string[], index: -1, position: 0 };
interface PlaybackControllerOptions {
  queue: Pick<QueueEngine, "select" | "seek" | "progress" | "playback" | "flush" | "subscribe">;
  selection: CacheSelection;
  tracks: Pick<TrackEngine, "getSource">;
  covers: Pick<CoverEngine, "ensureTrackCover">;
  isAvailable?: (id: string) => boolean;
}

/** Coordinates the selected queue with Player. No audio ownership or save timing. */
export class PlaybackController {
  #queue: PlaybackControllerOptions["queue"];
  #selection: PlaybackControllerOptions["selection"];
  #covers: PlaybackControllerOptions["covers"];
  #tracks: PlaybackControllerOptions["tracks"];
  #player?: ReturnType<typeof Player>;
  #isAvailable: (id: string) => boolean;
  #cleanup?: () => void;
  #id?: string;
  #cached = false;

  constructor(options: PlaybackControllerOptions) {
    this.#queue = options.queue;
    this.#selection = options.selection;
    this.#covers = options.covers;
    this.#tracks = options.tracks;
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

  #queueChanged = () => {
    const id = this.track?.id;
    if (id !== this.#id) {
      this.#id = id;
      this.suspend();
    }
  };
  setPosition(position: number) {
    if (this.#player) this.#queue.progress(position);
  }
  ended() {
    if (!this.#player) return;
    this.#queue.playback("inactive");
    void this.next();
  }

  attach(player: ReturnType<typeof Player>) {
    this.#cleanup?.();
    this.#player = player;
    const stopEffects = $effect.root(() => {
      $effect(() => {
        const status = player.status;
        const playing = player.playing;
        untrack(() => {
          this.#queue.playback(
            status === "idle" || status === "ended"
              ? "inactive"
              : playing || status === "loading" || status === "seeking"
                ? "active"
                : "paused",
          );
        });
      });
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
      unsubscribeQueue();
      document.removeEventListener("visibilitychange", hidden);
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
      position: this.#localQueue.position,
      getSource: async (options) => {
        const source = await this.#tracks.getSource(descriptor, options);
        // Player owns/reclaims even late results. Only current results affect
        // the controller's decision whether disconnect can keep audio running.
        if (!options.signal.aborted) this.#cached = source.cached;
        return {
          url: source.url,
          offset: source.offset,
          seekMode: source.cached ? "full" : source.nativeSeeking ? "seekable" : "buffered",
          release: source.release,
        };
      },
    };
  }
  async play() {
    const player = this.#player;
    if (!player) return;
    if (!this.#canPlay(this.#localQueue.index)) {
      await this.playIndex(this.#nextIndex(-1));
      return;
    }
    this.#queue.playback("active");
    if (player.status !== "idle") await player.resume();
    else {
      const track = this.#playerTrack();
      if (!track) return;
      this.#id = this.track?.id;
      await player.play(track);
    }
  }
  pause() {
    const player = this.#player;
    if (!player) return;
    player.pause();
    this.#queue.playback(
      player.status === "idle" || player.status === "ended" ? "inactive" : "paused",
    );
  }
  async toggle() {
    const player = this.#player;
    if (player && (player.playing || ["loading", "buffering", "seeking"].includes(player.status)))
      this.pause();
    else await this.play();
  }
  async playIndex(index: number) {
    if (!Number.isInteger(index) || !this.#canPlay(index)) return;
    this.#queue.select(index);
    this.suspend();
    await this.play();
  }
  async next() {
    if (this.#localQueue.index < 0) return;
    const index = this.#nextIndex(this.#localQueue.index);
    if (index >= 0) await this.playIndex(index);
  }
  async previous() {
    const index = this.#previousIndex();
    if (this.#canPlay(this.#localQueue.index) && (this.#localQueue.position > 3 || index < 0))
      await this.seek(0);
    else if (index >= 0) await this.playIndex(index);
  }
  async seek(position: number) {
    if (!Number.isFinite(position) || !this.#canPlay(this.#localQueue.index)) return;
    const duration = this.#player?.duration || this.track?.duration || 0;
    position = Math.max(0, duration > 0 ? Math.min(position, duration) : position);
    this.#queue.seek(position);
    // Seeking a restored queue edits its resume point without loading audio.
    if (this.#player?.status !== "idle") await this.#player?.seek(position);
  }
  suspendNetwork() {
    if (!this.#cached || this.#player?.status === "loading" || this.#player?.status === "seeking")
      this.suspend();
  }
  suspend() {
    this.#player?.unload();
    this.#cached = false;
    this.#queue.playback("inactive");
  }
  stop() {
    this.suspend();
    this.#queue.select(-1);
  }
  destroy() {
    this.#cleanup?.();
  }
}
