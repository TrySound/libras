import { untrack } from "svelte";
import { getAccountKey } from "./auth";
import type { CoverEngine } from "./cover.svelte";
import type { Cache, CachedQueue, CacheSelection, Immutable } from "./cache.svelte";
import type { QueueConnection, RemoteQueue } from "./network.svelte";
import type Player from "./player.svelte";
import type { PlayerTrack } from "./player.svelte";
import type { TrackEngine } from "./track.svelte";

const emptyQueue = { tracks: [] as readonly string[], index: -1, position: 0 };
interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
}
interface PlaybackOptions {
  selection: CacheSelection;
  tracks: TrackEngine;
  covers: CoverEngine;
  isAvailable?: (id: string) => boolean;
}

function fromRemoteQueue(remote: RemoteQueue, local: Immutable<CachedQueue>): CachedQueue {
  const sameSelection =
    remote.currentTrackId === local.tracks[local.index] &&
    remote.trackIds.length === local.tracks.length &&
    remote.trackIds.every((id, index) => id === local.tracks[index]);
  const index = sameSelection
    ? local.index
    : remote.currentTrackId
      ? remote.trackIds.indexOf(remote.currentTrackId)
      : -1;
  return {
    tracks: [...remote.trackIds],
    index,
    position: index >= 0 && Number.isFinite(remote.position) ? Math.max(0, remote.position) : 0,
  };
}
function toRemoteQueue(local: Immutable<CachedQueue>): RemoteQueue {
  return {
    trackIds: local.tracks,
    currentTrackId: local.tracks[local.index],
    position: local.position,
  };
}

/** Owns queue commands, Player coordination and server synchronization.
 * Cache remains the authoritative queue and owns local durability; Player owns audio. */
export class Playback {
  #selection: CacheSelection;
  #covers: CoverEngine;
  #tracks: TrackEngine;
  #player?: ReturnType<typeof Player>;
  #isAvailable: (id: string) => boolean;
  #cleanup?: () => void;
  #id?: string;
  #cached = false;
  #cover = $state.raw<ReturnType<CoverEngine["ensureTrackCover"]>>();
  #connection?: QueueConnection;
  #refreshPending?: Promise<void>;
  #refreshController?: AbortController;
  #serverWrites: Promise<void> = Promise.resolve();
  #queueError = $state.raw<unknown>();
  #playbackState: "active" | "paused" | "inactive" = "inactive";
  #lastProgressFlush = 0;
  #serverWritable = false;
  #dirty = false;
  #epoch = 0;
  #destroyed = false;
  #saveTimer?: ReturnType<typeof setTimeout>;

  constructor(options: PlaybackOptions) {
    this.#selection = options.selection;
    this.#covers = options.covers;
    this.#tracks = options.tracks;
    this.#isAvailable = options.isAvailable ?? (() => true);
  }
  get #localQueue() {
    return this.#selection.cache?.queue ?? emptyQueue;
  }
  get queueError() {
    return this.#queueError;
  }
  #canPlay(index: number) {
    const id = this.#localQueue.tracks[index];
    return id !== undefined && !!this.#selection.cache?.tracks.get(id) && this.#isAvailable(id);
  }
  get track() {
    const current = this.#localQueue.tracks[this.#localQueue.index];
    return current ? this.#selection.cache?.tracks.get(current) : undefined;
  }

  /** Reconcile synchronously after publication, never through a queue subscription. */
  #syncSelection() {
    const id = this.track?.id;
    if (id !== this.#id) {
      this.#id = id;
      this.suspend();
    }
  }
  /** Session calls this after selecting/loading local data. */
  activate() {
    if (this.#destroyed) return;
    this.#resetPolicy();
    this.#playbackState = "inactive";
    this.#lastProgressFlush = 0;
    this.#syncSelection();
  }
  setConnection(connection: QueueConnection | undefined) {
    if (this.#destroyed || connection === this.#connection) return;
    this.#connection = connection;
    this.#resetPolicy();
  }
  setPosition(position: number) {
    if (!this.#player || this.#destroyed) return;
    this.#setQueuePosition(position);
    if (this.#playbackState !== "active") this.#saveQueue();
    else if (Date.now() - this.#lastProgressFlush >= 10_000) {
      this.#lastProgressFlush = Date.now();
      void this.flushQueue();
    }
  }
  ended() {
    if (!this.#player || this.#destroyed) return;
    this.#setPlaybackState("inactive");
    void this.next();
  }

  attach(player: ReturnType<typeof Player>) {
    if (this.#destroyed) return () => {};
    this.#cleanup?.();
    this.#player = player;
    const stopEffects = $effect.root(() => {
      $effect(() => {
        const cover = this.#cover;
        const source = cover?.source;
        if (cover) untrack(() => player.setArtwork(source));
      });
      $effect(() => {
        const status = player.status;
        const playing = player.playing;
        untrack(() => {
          this.#setPlaybackState(
            status === "idle" || status === "ended"
              ? "inactive"
              : playing || status === "loading" || status === "seeking"
                ? "active"
                : "paused",
          );
        });
      });
    });
    const hidden = () => {
      if (document.visibilityState === "hidden") void this.flushQueue();
    };
    document.addEventListener("visibilitychange", hidden);
    this.#syncSelection();
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      stopEffects();
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
      artist: track.artistName ?? this.#selection.cache?.artists.get(track.artistId)?.name,
      album: this.#selection.cache?.albums.get(track.albumId)?.title,
      contentType: track.mimeType,
    };
    const cover = this.#covers.ensureTrackCover(track.id);
    this.#cover = cover;
    cover.load();
    return {
      metadata: {
        title: descriptor.title,
        artist: descriptor.artist,
        album: descriptor.album,
        duration: track.duration,
        artwork: cover.source,
      },
      position: this.#localQueue.position,
      getSource: async (options) => {
        const source = await this.#tracks.getSource(descriptor, options);
        // Player owns/reclaims even late results. Only current results affect
        // the decision whether disconnect can keep audio running.
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
    if (!player || this.#destroyed) return;
    if (this.#localQueue.index < 0) {
      await this.playIndex(0);
      return;
    }
    if (!this.#canPlay(this.#localQueue.index)) return;
    this.#setPlaybackState("active");
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
    this.#setPlaybackState(
      player.status === "idle" || player.status === "ended" ? "inactive" : "paused",
    );
  }
  async toggle() {
    const player = this.#player;
    if (player && (player.playing || ["loading", "buffering", "seeking"].includes(player.status)))
      this.pause();
    else await this.play();
  }
  /** Replace the queue without starting audio. Explicit replacements permit uploads
   * on this connection; progress alone never promotes an offline queue. */
  setQueue(state: QueueState) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed) return;
    this.#serverWritable = this.#connected(cache);
    this.#changeQueue(state);
    this.#saveQueue();
  }
  async replaceQueueAndPlay(tracks: readonly string[], startIndex = 0) {
    if (!tracks.length) {
      this.clearQueue();
      return;
    }
    this.setQueue({ tracks, position: 0 });
    await this.playIndex(Math.max(0, Math.min(startIndex, tracks.length - 1)));
  }
  async enqueue(tracks: readonly string[], placement: "next" | "last") {
    if (!tracks.length) return;
    const queue = this.#localQueue;
    if (!queue.tracks.length) await this.replaceQueueAndPlay(tracks);
    else {
      const index = placement === "next" ? queue.index + 1 : queue.tracks.length;
      this.setQueue({
        ...queue,
        tracks: [...queue.tracks.slice(0, index), ...tracks, ...queue.tracks.slice(index)],
      });
    }
  }
  clearQueue() {
    this.suspend();
    this.setQueue({ tracks: [], position: 0 });
  }
  async playIndex(index: number) {
    if (
      this.#destroyed ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.#localQueue.tracks.length
    )
      return;
    this.#changeQueue({ tracks: this.#localQueue.tracks, index, position: 0 });
    this.#saveQueue();
    this.suspend();
    await this.play();
  }
  async next() {
    if (this.#localQueue.index < 0) return;
    await this.playIndex(this.#localQueue.index + 1);
  }
  async previous() {
    if (this.#localQueue.position > 3 || this.#localQueue.index === 0) await this.seek(0);
    else await this.playIndex(this.#localQueue.index - 1);
  }
  async seek(position: number) {
    if (this.#destroyed || !Number.isFinite(position) || !this.#canPlay(this.#localQueue.index))
      return;
    const duration = this.#player?.duration || this.track?.duration || 0;
    position = Math.max(0, duration > 0 ? Math.min(position, duration) : position);
    this.#setQueuePosition(position);
    this.#saveQueue();
    // Seeking a restored queue edits its resume point without loading audio.
    if (this.#player?.status !== "idle") await this.#player?.seek(position);
  }
  suspendNetwork() {
    if (!this.#cached || this.#player?.status === "loading" || this.#player?.status === "seeking")
      this.suspend();
  }
  suspend() {
    this.#cover = undefined;
    this.#player?.unload();
    this.#cached = false;
    this.#setPlaybackState("inactive");
  }
  stop() {
    this.suspend();
    this.#changeQueue({ tracks: this.#localQueue.tracks, index: -1, position: 0 });
    this.#saveQueue();
  }

  #changeQueue(state: QueueState, checkpoint = false) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed) return;
    const requestedIndex = state.index ?? -1;
    const index =
      Number.isInteger(requestedIndex) &&
      requestedIndex >= 0 &&
      requestedIndex < state.tracks.length
        ? requestedIndex
        : -1;
    const position =
      index >= 0 && Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
    this.#refreshController?.abort();
    cache.setQueue({ tracks: state.tracks, index, position }, { checkpoint });
    this.#dirty = this.#serverWritable && this.#connected(cache);
    this.#syncSelection();
  }
  #setQueuePosition(position: number) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed || cache.queue.index < 0 || !Number.isFinite(position)) return;
    position = Math.max(0, position);
    if (position === cache.queue.position) return;
    this.#changeQueue({ ...cache.queue, position }, true);
  }

  // Connection-scoped synchronization policy. No independent queue state or lifecycle.
  #resetPolicy() {
    this.#refreshController?.abort();
    this.#refreshController = undefined;
    this.#refreshPending = undefined;
    this.#serverWrites = Promise.resolve();
    this.#queueError = undefined;
    this.#epoch++;
    this.#dirty = false;
    this.#serverWritable = false;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
  }
  #connected(cache: Cache) {
    return (
      !!this.#connection &&
      !this.#connection.signal.aborted &&
      cache.key === getAccountKey(this.#connection.account)
    );
  }
  #setPlaybackState(state: "active" | "paused" | "inactive") {
    if (this.#destroyed || state === this.#playbackState) return;
    this.#playbackState = state;
    if (state !== "inactive") this.#refreshController?.abort();
    if (state === "active") this.#saveQueue();
    else void this.flushQueue();
  }
  // Debounce explicit commands separately from periodic playback progress flushes.
  #saveQueue() {
    if (this.#destroyed) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.flushQueue();
    }, 300);
  }
  async flushQueue() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    try {
      await this.#selection.cache?.flush();
      await this.#writeServer();
    } catch {
      // Cache retains checkpoint errors and dirty data for retry.
    }
  }
  #writeServer(): Promise<void> {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    const epoch = this.#epoch;
    const valid = () =>
      !this.#destroyed &&
      epoch === this.#epoch &&
      !!cache &&
      cache === this.#selection.cache &&
      this.#connected(cache);
    const task = this.#serverWrites.then(async () => {
      if (!cache || !connection || !valid()) return;
      const revision = cache.queueRevision;
      await cache.flush();
      if (!valid() || !this.#dirty || cache.queueDirty || revision !== cache.queueRevision) return;
      const state = cache.queue;
      this.#queueError = undefined;
      try {
        await connection.write(toRemoteQueue(state));
        if (valid() && revision === cache.queueRevision) this.#dirty = false;
      } catch (error) {
        if (valid()) this.#queueError = error;
      }
    });
    // A failed checkpoint rejects this attempt without poisoning later attempts.
    this.#serverWrites = task.catch(() => {});
    return task;
  }
  refreshQueue(): Promise<void> {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    if (!connection || !cache || !this.#connected(cache) || this.#destroyed)
      return Promise.resolve();
    if (this.#refreshPending) return this.#refreshPending;
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#refreshController = controller;
    const signal = AbortSignal.any([connection.signal, controller.signal]);
    const current = () =>
      epoch === this.#epoch &&
      !this.#destroyed &&
      cache === this.#selection.cache &&
      !connection.signal.aborted;
    return (this.#refreshPending = (async () => {
      try {
        try {
          await this.#writeServer();
        } catch {
          // Cache reports checkpoint failures; do not retain a duplicate sync error.
          return;
        }
        if (!current()) return;
        this.#queueError = undefined;
        const revision = cache.queueRevision;
        const remote = await connection.read();
        if (
          !current() ||
          signal.aborted ||
          revision !== cache.queueRevision ||
          this.#playbackState !== "inactive"
        )
          return;
        cache.setQueue(fromRemoteQueue(remote, cache.queue));
        this.#dirty = false;
        this.#serverWritable = true;
        this.#syncSelection();
      } catch (error) {
        if (current() && !signal.aborted) this.#queueError = error;
      }
    })().finally(() => {
      if (this.#refreshController === controller) this.#refreshController = undefined;
      if (epoch === this.#epoch) this.#refreshPending = undefined;
    }));
  }
  destroy() {
    this.#destroyed = true;
    this.#cleanup?.();
    this.#resetPolicy();
    return (
      this.#selection.cache?.flush().then(
        () => {},
        () => {},
      ) ?? Promise.resolve()
    );
  }
}
