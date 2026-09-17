import { getAccountKey } from "./auth";
import type { Covers } from "./covers.svelte";
import type { Cache, CachedQueue, CacheSelection, Immutable } from "./cache.svelte";
import type { QueueConnection, RemoteQueue } from "./network.svelte";
import type Player from "./player.svelte";
import type { PlayerState, PlayerTrack } from "./player.svelte";
import type { TrackEngine } from "./track.svelte";

type PlaybackActivity = "active" | "paused" | "inactive";

function playerActivity(player: PlayerState): PlaybackActivity {
  if (player.status === "idle" || player.status === "ended") return "inactive";
  const starting = player.status === "loading" || player.status === "seeking";
  return player.playing || starting ? "active" : "paused";
}

const emptyQueue = { tracks: [] as readonly string[], index: -1, position: 0 };
interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
}
interface PlaybackOptions {
  selection: CacheSelection;
  tracks: TrackEngine;
  covers: Covers;
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
  #covers: Covers;
  #tracks: TrackEngine;
  #player?: ReturnType<typeof Player>;
  #isAvailable: (id: string) => boolean;
  #cleanup?: () => void;
  #selectedTrackId?: string;
  #sourceIsCached = false;
  #connection?: QueueConnection;
  #refreshPending?: Promise<void>;
  #refreshController?: AbortController;
  #uploadTail: Promise<void> = Promise.resolve();
  #queueError = $state.raw<unknown>();
  #activity: PlaybackActivity = "inactive";
  #lastProgressFlush = 0;
  // Reconnect/progress must not replace a remote queue with an offline one.
  // Only server adoption or an explicit replacement grants upload permission.
  #uploadAllowed = false;
  #uploadPending = false;
  #syncVersion = 0;
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
  #syncSelection(restart = false) {
    const id = this.track?.id;
    if (!restart && id === this.#selectedTrackId) return;
    this.#selectedTrackId = id;
    this.suspend();
  }
  /** Session calls this after selecting/loading local data. */
  activate() {
    if (this.#destroyed) return;
    this.#resetSync();
    this.#activity = "inactive";
    this.#lastProgressFlush = 0;
    this.#syncSelection();
  }
  setConnection(connection: QueueConnection | undefined) {
    if (this.#destroyed || connection === this.#connection) return;
    this.#connection = connection;
    this.#resetSync();
  }
  setPosition(position: number) {
    if (!this.#player || this.#destroyed) return;
    this.#setQueuePosition(position);
    if (this.#activity !== "active") this.#scheduleQueueFlush();
    else if (Date.now() - this.#lastProgressFlush >= 10_000) {
      this.#lastProgressFlush = Date.now();
      void this.flushQueue();
    }
  }
  updatePlayerState(state: PlayerState) {
    if (!this.#player || this.#destroyed) return;
    this.#setActivity(playerActivity(state));
  }
  ended() {
    if (!this.#player || this.#destroyed) return;
    void this.next();
  }

  attach(player: ReturnType<typeof Player>) {
    if (this.#destroyed) return () => {};
    this.#cleanup?.();
    this.#player = player;
    const hidden = () => {
      if (document.visibilityState === "hidden") void this.flushQueue();
    };
    document.addEventListener("visibilitychange", hidden);
    this.#syncSelection();
    this.updatePlayerState(player);
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("visibilitychange", hidden);
      this.suspend();
      this.#player = undefined;
      this.#selectedTrackId = undefined;
      this.#cleanup = undefined;
    };
    this.#cleanup = cleanup;
    return cleanup;
  }

  #playerTrack(): PlayerTrack | undefined {
    const cache = this.#selection.cache;
    const track = this.track;
    if (!cache || !track || !this.#canPlay(this.#localQueue.index)) return;
    const descriptor = {
      id: track.id,
      contentType: track.mimeType,
    };
    const selection = this.#selection;
    const covers = this.#covers;
    let cover: ReturnType<Covers["ensureCover"]> | undefined;
    const artwork = () => {
      if (selection.cache !== cache) return;
      const current = covers.ensureCover(cache.tracks.get(track.id)?.artworkId);
      // A new reference needs acquisition; URL publication does not.
      if (current !== cover) {
        cover = current;
        cover.load();
      }
      return cover.source;
    };
    artwork();
    return {
      metadata: {
        title: track.title,
        artist: track.artistName ?? cache.artists.get(track.artistId)?.name,
        album: cache.albums.get(track.albumId)?.title,
        duration: track.duration,
        get artwork() {
          return artwork();
        },
      },
      position: this.#localQueue.position,
      getSource: async (options) => {
        const source = await this.#tracks.getSource(descriptor, options);
        // Player owns/reclaims even late results. Only current results affect
        // the decision whether disconnect can keep audio running.
        if (!options.signal.aborted) this.#sourceIsCached = source.cached;
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
    this.#setActivity("active");
    if (player.status !== "idle") await player.resume();
    else {
      const track = this.#playerTrack();
      if (!track) return;
      this.#selectedTrackId = this.track?.id;
      await player.play(track);
    }
  }
  pause() {
    this.#player?.pause();
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
    this.#changeQueue(state, { replace: true });
  }
  async replaceQueueAndPlay(tracks: readonly string[], startIndex = 0) {
    if (!tracks.length) {
      this.clearQueue();
      return;
    }
    const index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    this.#changeQueue({ tracks, index, position: 0 }, { replace: true, restart: true });
    if (Number.isInteger(index)) await this.play();
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
    this.#changeQueue({ tracks: [], position: 0 }, { replace: true, restart: true });
  }
  async playIndex(index: number) {
    if (
      this.#destroyed ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.#localQueue.tracks.length
    )
      return;
    this.#changeQueue({ tracks: this.#localQueue.tracks, index, position: 0 }, { restart: true });
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
    this.#scheduleQueueFlush();
    // Seeking a restored queue edits its resume point without loading audio.
    if (this.#player?.status !== "idle") await this.#player?.seek(position);
  }
  suspendNetwork() {
    if (
      !this.#sourceIsCached ||
      this.#player?.status === "loading" ||
      this.#player?.status === "seeking"
    )
      this.suspend();
  }
  suspend() {
    this.#player?.unload();
    this.#sourceIsCached = false;
    this.#setActivity("inactive");
  }
  stop() {
    this.#changeQueue(
      { tracks: this.#localQueue.tracks, index: -1, position: 0 },
      { restart: true },
    );
  }

  #changeQueue(state: QueueState, { replace = false, restart = false } = {}) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed) return;
    const requestedIndex = state.index ?? -1;
    const validIndex =
      Number.isInteger(requestedIndex) &&
      requestedIndex >= 0 &&
      requestedIndex < state.tracks.length;
    const index = validIndex ? requestedIndex : -1;
    const position =
      index >= 0 && Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
    if (replace) this.#uploadAllowed = this.#hasConnection(cache);
    cache.setQueue({ tracks: state.tracks, index, position });
    this.#queueEdited(cache);
    this.#syncSelection(restart);
    this.#scheduleQueueFlush();
  }
  #setQueuePosition(position: number) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed || cache.queue.index < 0 || !Number.isFinite(position)) return;
    position = Math.max(0, position);
    if (position === cache.queue.position) return;
    cache.setQueue({ ...cache.queue, position }, { checkpoint: true });
    this.#queueEdited(cache);
    // A clock update never changes selection, but metadata may have removed the
    // selected track since playback began. Preserve its saved queue/resume point.
    if (this.#selectedTrackId !== undefined && !cache.tracks.has(this.#selectedTrackId)) {
      this.#selectedTrackId = undefined;
      this.suspend();
    }
  }
  #queueEdited(cache: Cache) {
    this.#refreshController?.abort();
    this.#uploadPending = this.#uploadAllowed && this.#hasConnection(cache);
  }

  // Connection-scoped synchronization policy. No independent queue state or lifecycle.
  #resetSync() {
    this.#refreshController?.abort();
    this.#refreshController = undefined;
    this.#refreshPending = undefined;
    this.#uploadTail = Promise.resolve();
    this.#queueError = undefined;
    this.#syncVersion++;
    this.#uploadPending = false;
    this.#uploadAllowed = false;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
  }
  #hasConnection(cache: Cache) {
    return (
      !!this.#connection &&
      !this.#connection.signal.aborted &&
      cache.key === getAccountKey(this.#connection.account)
    );
  }
  /** Commands publish intent before awaiting Player; explicit transport events
   * reconcile actual status here. Both paths share idempotent save/read policy. */
  #setActivity(state: PlaybackActivity) {
    if (this.#destroyed || state === this.#activity) return;
    this.#activity = state;
    if (state !== "inactive") this.#refreshController?.abort();
    if (state === "active") this.#scheduleQueueFlush();
    else void this.flushQueue();
  }
  // Debounce explicit commands separately from periodic playback progress flushes.
  #scheduleQueueFlush() {
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
      await this.#uploadQueue();
    } catch {
      // Cache retains checkpoint errors and dirty data for retry.
    }
  }
  #uploadQueue(): Promise<void> {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    if (!cache || !connection || !this.#hasConnection(cache) || this.#destroyed)
      return Promise.resolve();
    const version = this.#syncVersion;
    const isCurrentConnection = () =>
      !this.#destroyed &&
      version === this.#syncVersion &&
      cache === this.#selection.cache &&
      !connection.signal.aborted;
    const task = this.#uploadTail.then(async () => {
      if (!isCurrentConnection()) return;
      const revision = cache.queueRevision;
      await cache.flush();
      if (!isCurrentConnection() || !this.#uploadPending) return;
      const checkpointIsCurrent = !cache.queueDirty && revision === cache.queueRevision;
      if (!checkpointIsCurrent) return;
      const state = cache.queue;
      this.#queueError = undefined;
      try {
        await connection.write(toRemoteQueue(state));
        if (isCurrentConnection() && revision === cache.queueRevision) this.#uploadPending = false;
      } catch (error) {
        if (isCurrentConnection()) this.#queueError = error;
      }
    });
    // A failed checkpoint rejects this attempt without poisoning later attempts.
    this.#uploadTail = task.catch(() => {});
    return task;
  }
  refreshQueue(): Promise<void> {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    if (!connection || !cache || !this.#hasConnection(cache) || this.#destroyed)
      return Promise.resolve();
    if (this.#refreshPending) return this.#refreshPending;
    const version = this.#syncVersion;
    const controller = new AbortController();
    this.#refreshController = controller;
    const signal = AbortSignal.any([connection.signal, controller.signal]);
    const isCurrentConnection = () =>
      version === this.#syncVersion &&
      !this.#destroyed &&
      cache === this.#selection.cache &&
      !connection.signal.aborted;
    return (this.#refreshPending = (async () => {
      try {
        try {
          await this.#uploadQueue();
        } catch {
          // Cache reports checkpoint failures; do not retain a duplicate sync error.
          return;
        }
        if (!isCurrentConnection()) return;
        this.#queueError = undefined;
        const revision = cache.queueRevision;
        const remote = await connection.read();
        if (!isCurrentConnection() || signal.aborted) return;
        const queueWasEdited = revision !== cache.queueRevision;
        const playbackInUse = this.#activity !== "inactive";
        if (queueWasEdited || playbackInUse) return;
        cache.setQueue(fromRemoteQueue(remote, cache.queue));
        this.#uploadPending = false;
        this.#uploadAllowed = true;
        this.#syncSelection();
      } catch (error) {
        if (isCurrentConnection() && !signal.aborted) this.#queueError = error;
      }
    })().finally(() => {
      if (this.#refreshController === controller) this.#refreshController = undefined;
      if (version === this.#syncVersion) this.#refreshPending = undefined;
    }));
  }
  destroy() {
    this.#destroyed = true;
    this.#cleanup?.();
    this.#resetSync();
    return (
      this.#selection.cache?.flush().then(
        () => {},
        () => {},
      ) ?? Promise.resolve()
    );
  }
}
