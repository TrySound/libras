import type { Storage, QueueRecord } from "./storage";
import type { QueueConnection } from "./network.svelte";
import type { Memory } from "./memory.svelte";
import type { Account } from "./schema";

type QueueMemory = Pick<Memory, "serverQueue" | "queueTracks" | "queueIndex" | "queuePosition">;

export interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
}
const scope = (account: Account) => `${account.host}\n${account.username}`;

export class QueueEngine {
  #connection?: QueueConnection;
  #account?: Account;
  #memory: QueueMemory;

  constructor(memory: QueueMemory) {
    this.#memory = memory;
  }
  #playbackActive = false;
  #serverWritable = false;

  setPlaybackActive(active: boolean) {
    this.#playbackActive = active;
  }

  #dirty = false;
  #needsPersist = false;
  #conflict = false;
  #storage?: Pick<Storage, "account" | "queue">;
  #connecting?: { epoch: number; promise: Promise<void> };
  #updatedAt = 0;
  #revision = 0;
  #epoch = 0;
  #accountGeneration = 0;
  #loaded = false;
  #destroyed = false;
  #ready: Promise<void> = Promise.resolve();
  #localWrites: Promise<unknown> = Promise.resolve();
  #serverWrites: Promise<unknown> = Promise.resolve();
  #error = $state.raw<unknown>();
  #storageError = $state.raw<unknown>();
  #saveTimer?: ReturnType<typeof setTimeout>;
  #localTimer?: ReturnType<typeof setTimeout>;
  #listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }
  get error() {
    return this.#error;
  }
  get storageError() {
    return this.#storageError;
  }
  #publish(state: QueueState) {
    const tracks = [...state.tracks];
    const requestedIndex = state.index ?? -1;
    const index =
      Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < tracks.length
        ? requestedIndex
        : -1;
    const position =
      index >= 0 && Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
    // Publish every queue field before synchronous playback subscribers run.
    this.#memory.queueTracks = tracks;
    this.#memory.queueIndex = index;
    this.#memory.queuePosition = position;
    this.#notify();
  }
  #state() {
    return {
      tracks: this.#memory.queueTracks,
      index: this.#memory.queueIndex,
      position: this.#memory.queuePosition,
    };
  }
  #serverState() {
    const state = this.#memory.serverQueue;
    return state
      ? { tracks: [...state.tracks], index: state.index, position: state.position }
      : undefined;
  }

  #persist(): Promise<void> {
    if (!this.#account || !this.#storage || !this.#needsPersist)
      return this.#localWrites.then(() => {});
    const account = this.#account;
    const storage = this.#storage;
    const revision = this.#revision;
    const record: QueueRecord = {
      account,
      tracks: [...this.#memory.queueTracks],
      index: this.#memory.queueIndex,
      position: this.#memory.queuePosition,
      // Retain the legacy field for file compatibility, never as an upload outbox.
      pendingSync: false,
      updatedAt: this.#updatedAt,
      server: this.#serverState(),
    };
    // Also retain an engine-wide tail so teardown waits for writes to previous accounts.
    const result = this.#localWrites
      .then(() => {
        // A queued checkpoint must retain a server snapshot committed ahead of it.
        if (this.#account === account) record.server = this.#serverState();
        return storage.queue.save(record);
      })
      .then(({ written }) => {
        if (this.#account !== account) return;
        if (!written) {
          this.#conflict = true;
          this.#storageError = new Error(
            "A newer queue was saved in another tab. This queue has not been saved.",
          );
          return;
        }
        if (revision === this.#revision) {
          this.#conflict = false;
          this.#storageError = undefined;
          this.#needsPersist = false;
        }
      })
      .catch((error) => {
        if (this.#account === account) this.#storageError = error;
      });
    this.#localWrites = result;
    return result;
  }

  restore(storage: Pick<Storage, "account" | "queue">): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    const identity = storage.account;
    if (this.#account && scope(this.#account) === scope(identity)) return this.#ready;
    void this.#persist();
    this.#clearTimers();
    const account = { host: identity.host, username: identity.username };
    this.#account = account;
    this.#storage = storage;
    this.#epoch++;
    const generation = ++this.#accountGeneration;
    const revision = ++this.#revision;
    this.#loaded = false;
    this.#playbackActive = false;
    this.#serverWritable = false;
    this.#memory.serverQueue = null;
    this.#dirty = false;
    this.#needsPersist = false;
    this.#conflict = false;
    this.#updatedAt = 0;
    this.#error = undefined;
    this.#storageError = undefined;
    if (this.#connection && scope(this.#connection.account) !== scope(account))
      this.#connection = undefined;
    this.#publish({ tracks: [], position: 0 });
    return (this.#ready = (async () => {
      try {
        const record = await storage.queue.read();
        if (generation !== this.#accountGeneration || this.#destroyed) return;
        if (record && revision === this.#revision) {
          // Older records did not distinguish the server replica from local playback.
          this.#memory.serverQueue = record.server ?? null;
          this.#updatedAt = record.updatedAt;
          this.#publish(record);
        }
      } catch (error) {
        if (generation === this.#accountGeneration) this.#storageError = error;
      } finally {
        if (generation === this.#accountGeneration && !this.#destroyed) {
          this.#loaded = true;
          if (revision !== this.#revision) await this.#persist();
        }
      }
    })());
  }

  async #load() {
    const connection = this.#connection;
    const storage = this.#storage;
    const account = this.#account;
    if (!connection || !storage || !account || connection.signal.aborted || this.#destroyed) return;
    const epoch = this.#epoch;
    const revision = this.#revision;
    const valid = () =>
      epoch === this.#epoch &&
      revision === this.#revision &&
      !this.#destroyed &&
      !connection.signal.aborted;
    this.#error = undefined;
    try {
      const queue = await connection.read();
      if (!valid()) return;
      this.#updatedAt = Math.max(Date.now(), this.#updatedAt + 1);
      // Remote queues identify the selection by ID, so retain our occurrence index
      // when an unchanged server queue contains the same track more than once.
      const sameSelection =
        queue.currentTrackId === this.#memory.queueTracks[this.#memory.queueIndex] &&
        queue.trackIds.length === this.#memory.queueTracks.length &&
        queue.trackIds.every((id, index) => id === this.#memory.queueTracks[index]);
      const index = sameSelection
        ? this.#memory.queueIndex
        : queue.currentTrackId
          ? queue.trackIds.indexOf(queue.currentTrackId)
          : -1;
      const record: QueueRecord = {
        account,
        pendingSync: false,
        updatedAt: this.#updatedAt,
        tracks: [...queue.trackIds],
        index,
        position: index >= 0 && Number.isFinite(queue.position) ? Math.max(0, queue.position) : 0,
      };
      // Serialize with local checkpoints, but do not expose the remote queue until durable.
      const write = this.#localWrites.then(async () => {
        if (!valid()) return;
        try {
          const server = { tracks: record.tracks, index: record.index, position: record.position };
          const preservePlayback = this.#playbackActive;
          const saved = {
            ...record,
            ...(preservePlayback ? this.#state() : {}),
            tracks: [...(preservePlayback ? this.#memory.queueTracks : record.tracks)],
            server,
          };
          const result = await storage.queue.save(saved);
          if (!valid()) return;
          if (!result.written) {
            this.#storageError = new Error(
              "A newer queue is already stored. Refresh to try again.",
            );
            return;
          }
          this.#dirty = false;
          this.#needsPersist = false;
          this.#conflict = false;
          this.#storageError = undefined;
          this.#memory.serverQueue = server;
          if (!this.#playbackActive && !preservePlayback) {
            this.#serverWritable = true;
            this.#publish(record);
          }
        } catch (error) {
          if (valid()) this.#storageError = error;
        }
      });
      this.#localWrites = write.catch(() => {});
      await write;
    } catch (error) {
      if (
        epoch !== this.#epoch ||
        revision !== this.#revision ||
        this.#destroyed ||
        connection.signal.aborted
      )
        return;
      this.#error = error;
    }
  }

  #sync(): Promise<void> {
    const connection = this.#connection;
    const epoch = this.#epoch;
    const result = this.#serverWrites.then(async () => {
      if (
        !connection ||
        !this.#account ||
        scope(connection.account) !== scope(this.#account) ||
        epoch !== this.#epoch ||
        connection.signal.aborted ||
        !this.#loaded ||
        !this.#dirty ||
        this.#conflict ||
        this.#destroyed
      )
        return;
      const revision = this.#revision;
      const state = this.#state();
      this.#error = undefined;
      try {
        await connection.write({
          trackIds: state.tracks,
          currentTrackId: state.tracks[state.index],
          position: state.position,
        });
        if (epoch !== this.#epoch || this.#destroyed || connection.signal.aborted) return;
        this.#memory.serverQueue = { ...state, tracks: [...state.tracks] };
        if (revision === this.#revision) {
          this.#dirty = false;
          this.#needsPersist = true;
          await this.#persist();
        }
        if (epoch !== this.#epoch || this.#destroyed || connection.signal.aborted) return;
      } catch (error) {
        if (epoch !== this.#epoch || this.#destroyed || connection.signal.aborted) return;
        this.#error = error;
      }
    });
    this.#serverWrites = result.catch(() => {});
    return result;
  }

  #changed() {
    this.#revision++;
    this.#updatedAt = Math.max(Date.now(), this.#updatedAt + 1);
    this.#dirty = this.#serverWritable && !!this.#connection && !this.#connection.signal.aborted;
    this.#needsPersist = true;
  }
  update(state: QueueState) {
    this.#serverWritable = !!this.#connection && !this.#connection.signal.aborted;
    this.#changed();
    this.#publish(state);
    this.save();
  }
  select(index: number) {
    // Navigation belongs to the existing session, including an offline-only queue.
    this.#changed();
    this.#publish({ tracks: this.#memory.queueTracks, index, position: 0 });
    this.save();
  }
  setPosition(position: number) {
    if (this.#memory.queueIndex < 0 || !Number.isFinite(position)) return;
    position = Math.max(0, position);
    if (position === this.#memory.queuePosition) return;
    this.#memory.queuePosition = position;
    this.#changed();
    this.#notify();
    // A throttle, not a debounce: continuous playback still gets local checkpoints.
    if (!this.#localTimer)
      this.#localTimer = setTimeout(() => {
        this.#localTimer = undefined;
        void this.#persist();
      }, 5000);
  }
  save() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.flush();
    }, 300);
  }
  #clearTimers() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    clearTimeout(this.#localTimer);
    this.#localTimer = undefined;
  }
  async flush() {
    this.#clearTimers();
    await this.#persist();
    await this.#sync();
  }
  #connect() {
    if (this.#connecting?.epoch === this.#epoch) return this.#connecting.promise;
    const epoch = this.#epoch;
    const promise = (async () => {
      if (!this.#connection || this.#connection.signal.aborted) return;
      if (this.#dirty) await this.#sync();
      if (epoch === this.#epoch) await this.#load();
    })();
    const connecting = { epoch: this.#epoch, promise };
    this.#connecting = connecting;
    return promise.finally(() => {
      if (this.#connecting === connecting) this.#connecting = undefined;
    });
  }
  setConnection(connection: QueueConnection | undefined) {
    if ((connection && connection === this.#connection) || this.#destroyed) return;
    this.#connection = connection;
    this.#epoch++;
    // Only edits made on this connection may be uploaded.
    this.#dirty = false;
    this.#serverWritable = false;
    this.#clearTimers();
  }
  async synchronize() {
    const epoch = this.#epoch;
    await this.#ready;
    if (epoch !== this.#epoch || this.#destroyed) return;
    if (
      !this.#account ||
      !this.#connection ||
      scope(this.#account) !== scope(this.#connection.account)
    )
      return;
    await this.#persist();
    if (epoch === this.#epoch && !this.#destroyed) await this.#connect();
  }
  destroy() {
    const persisted = this.#persist();
    this.#clearTimers();
    this.#destroyed = true;
    this.#epoch++;
    this.#accountGeneration++;
    this.#listeners.clear();
    return persisted;
  }
}
