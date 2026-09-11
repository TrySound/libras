import type { Cache, CachedQueue, CacheSelection, Immutable } from "./cache.svelte";
import type { QueueConnection, RemoteQueue } from "./network.svelte";

interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
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

/** Queue commands and connection-scoped server policy; Cache owns all local durability. */
export class QueueEngine {
  #selection: CacheSelection;
  #connection?: QueueConnection;
  #refreshPending?: Promise<void>;
  #refreshController?: AbortController;
  #serverWrites: Promise<void> = Promise.resolve();
  #error = $state.raw<unknown>();
  #playbackState: "active" | "paused" | "inactive" = "inactive";
  #lastProgressFlush = 0;
  #serverWritable = false;
  #dirty = false;
  #epoch = 0;
  #destroyed = false;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #listeners = new Set<() => void>();

  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }

  get error() {
    return this.#error;
  }
  get storageError() {
    return this.#selection.cache?.queueError;
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }

  /** Session calls this after selecting/loading local data; no hydration or selection here. */
  activate() {
    if (this.#destroyed) return;
    this.#resetPolicy();
    this.#playbackState = "inactive";
    this.#lastProgressFlush = 0;
    this.#notify();
  }
  #resetPolicy() {
    this.#refreshController?.abort();
    this.#refreshController = undefined;
    this.#refreshPending = undefined;
    this.#serverWrites = Promise.resolve();
    this.#error = undefined;
    this.#epoch++;
    this.#dirty = false;
    this.#serverWritable = false;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
  }
  setConnection(connection: QueueConnection | undefined) {
    if (this.#destroyed || connection === this.#connection) return;
    this.#connection = connection;
    this.#resetPolicy();
  }
  /** Transport lifecycle owns no upload timers; QueueEngine owns this policy. */
  playback(state: "active" | "paused" | "inactive") {
    if (this.#destroyed || state === this.#playbackState) return;
    this.#playbackState = state;
    if (state !== "inactive") this.#refreshController?.abort();
    if (state === "active") this.save();
    else void this.flush();
  }
  progress(position: number) {
    if (this.#destroyed) return;
    this.setPosition(position);
    if (this.#playbackState !== "active") this.save();
    else if (Date.now() - this.#lastProgressFlush >= 10_000) {
      this.#lastProgressFlush = Date.now();
      void this.flush();
    }
  }
  seek(position: number) {
    this.setPosition(position);
    this.save();
  }
  #connected(cache: Cache) {
    return (
      !!this.#connection &&
      !!cache.account &&
      !this.#connection.signal.aborted &&
      this.#connection.account.host === cache.account.host &&
      this.#connection.account.username === cache.account.username
    );
  }

  #change(state: QueueState, checkpoint = false) {
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
    // Cache publishes the entire value before explicit playback callbacks run.
    this.#notify();
  }
  update(state: QueueState) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed) return;
    this.#serverWritable = this.#connected(cache);
    this.#change(state);
    this.save();
  }
  select(index: number) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed) return;
    this.#change({ tracks: cache.queue.tracks, index, position: 0 });
    this.save();
  }
  setPosition(position: number) {
    const cache = this.#selection.cache;
    if (!cache || this.#destroyed || cache.queue.index < 0 || !Number.isFinite(position)) return;
    position = Math.max(0, position);
    if (position === cache.queue.position) return;
    this.#change({ ...cache.queue, position }, true);
  }
  // Debounce explicit commands separately from periodic playback progress flushes.
  save() {
    if (this.#destroyed) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.flush();
    }, 300);
  }
  async flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    try {
      await this.#selection.cache?.flush();
    } catch {
      return;
    }
    await this.#writeServer();
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
      let saved: number;
      try {
        saved = await cache.flush();
      } catch {
        return;
      }
      if (
        !valid() ||
        !this.#dirty ||
        cache.queueError ||
        cache.queueDirty ||
        saved !== cache.queueRevision
      )
        return;
      const revision = cache.queueRevision;
      const state = cache.queue;
      this.#error = undefined;
      try {
        await connection.write(toRemoteQueue(state));
        if (valid() && revision === cache.queueRevision) this.#dirty = false;
      } catch (error) {
        if (valid()) this.#error = error;
      }
    });
    this.#serverWrites = task;
    return task;
  }

  refresh(): Promise<void> {
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
        await this.#writeServer();
        if (!current()) return;
        this.#error = undefined;
        const revision = cache.queueRevision;
        const remote = await connection.read();
        if (
          !current() ||
          signal.aborted ||
          revision !== cache.queueRevision ||
          this.#playbackState !== "inactive"
        )
          return;
        const next = fromRemoteQueue(remote, cache.queue);
        const adopted = await cache.replaceQueue(next, signal);
        if (!current() || !adopted) return;
        this.#dirty = false;
        this.#serverWritable = true;
        this.#notify();
      } catch (error) {
        if (current() && !signal.aborted && error !== cache.queueError) this.#error = error;
      }
    })().finally(() => {
      if (this.#refreshController === controller) this.#refreshController = undefined;
      if (epoch === this.#epoch) this.#refreshPending = undefined;
    }));
  }
  destroy() {
    this.#destroyed = true;
    this.#resetPolicy();
    this.#listeners.clear();
    return (
      this.#selection.cache?.flush().then(
        () => {},
        () => {},
      ) ?? Promise.resolve()
    );
  }
}
