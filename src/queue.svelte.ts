import type { Storage, QueueRecord, QueueSnapshot } from "./storage";
import type { QueueConnection, RemoteQueue } from "./network.svelte";
import type { Immutable, Memory } from "./memory.svelte";
import type { Account } from "./schema";

type QueueMemory = Pick<Memory, "serverQueue" | "queueTracks" | "queueIndex" | "queuePosition">;

export interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
}
const scope = (account: Account) => `${account.host}\n${account.username}`;

function fromRemoteQueue(remote: RemoteQueue, local: Immutable<QueueSnapshot>): QueueSnapshot {
  // An ID cannot distinguish duplicate occurrences. Preserve the local occurrence
  // only when the server's track list and selected ID are unchanged.
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

function toRemoteQueue(local: Immutable<QueueSnapshot>): RemoteQueue {
  return {
    trackIds: local.tracks,
    currentTrackId: local.tracks[local.index],
    position: local.position,
  };
}

export class QueueEngine {
  #connection?: QueueConnection;
  #refreshPending?: Promise<void>;
  #serverWrites: Promise<void> = Promise.resolve();
  #error = $state.raw<unknown>();
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
  #storage?: Pick<Storage, "account" | "queue">;
  #updatedAt = 0;
  #revision = 0;
  #epoch = 0;
  #accountGeneration = 0;
  #destroyed = false;
  #ready: Promise<void> = Promise.resolve();
  #localWrites: Promise<unknown> = Promise.resolve();
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
          this.#storageError = new Error(
            "A newer queue was saved in another tab. This queue has not been saved.",
          );
          return;
        }
        if (revision === this.#revision) {
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
    this.#playbackActive = false;
    this.#serverWritable = false;
    this.#memory.serverQueue = null;
    this.#dirty = false;
    this.#needsPersist = false;
    this.#updatedAt = 0;
    this.#storageError = undefined;
    this.#error = undefined;
    this.#refreshPending = undefined;
    this.#serverWrites = Promise.resolve();
    if (this.#connection && scope(this.#connection.account) !== scope(account))
      this.setConnection(undefined);
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
          if (revision !== this.#revision) await this.#persist();
        }
      }
    })());
  }

  refresh(): Promise<void> {
    const connection = this.#connection;
    if (!connection || connection.signal.aborted || this.#destroyed) return Promise.resolve();
    if (this.#refreshPending) return this.#refreshPending;
    const epoch = this.#epoch;
    const current = () => epoch === this.#epoch && !this.#destroyed && !connection.signal.aborted;
    return (this.#refreshPending = (async () => {
      try {
        await this.#ready;
        if (!current()) return;
        const storage = this.#storage;
        const account = this.#account;
        if (!storage || !account || scope(account) !== scope(connection.account)) return;
        await this.#writeServer();
        if (!current()) return;
        this.#error = undefined;
        const revision = this.#revision;
        const valid = () => current() && revision === this.#revision;
        const local = this.#state();
        const remote = await connection.read();
        if (!valid()) return;
        const queue = fromRemoteQueue(remote, local);
        this.#updatedAt = Math.max(Date.now(), this.#updatedAt + 1);
        await this.#saveServer(queue, revision, valid, "refresh");
      } catch (error) {
        if (current()) this.#error = error;
      }
    })().finally(() => {
      if (epoch === this.#epoch) this.#refreshPending = undefined;
    }));
  }

  #writeServer(): Promise<void> {
    const connection = this.#connection;
    const epoch = this.#epoch;
    const valid = () =>
      epoch === this.#epoch && !this.#destroyed && !!connection && !connection.signal.aborted;
    const task = this.#serverWrites.then(async () => {
      if (!connection || !valid()) return;
      try {
        await this.#ready;
        await this.#persist();
        const account = this.#account;
        const storage = this.#storage;
        if (
          !valid() ||
          !account ||
          !storage ||
          scope(account) !== scope(connection.account) ||
          !this.#dirty ||
          this.#storageError
        )
          return;
        const revision = this.#revision;
        const state = this.#state();
        this.#error = undefined;
        await connection.write(toRemoteQueue(state));
        if (!valid()) return;
        await this.#saveServer(state, revision, valid, "acknowledge");
      } catch (error) {
        if (valid()) this.#error = error;
      }
    });
    this.#serverWrites = task;
    return task;
  }

  #saveServer(
    snapshot: Immutable<QueueSnapshot>,
    revision: number,
    valid: () => boolean,
    mode: "refresh" | "acknowledge",
  ): Promise<void> {
    const account = this.#account;
    const storage = this.#storage;
    if (!account || !storage) return Promise.resolve();
    const server = { ...snapshot, tracks: [...snapshot.tracks] };
    const write = this.#localWrites.then(async () => {
      if (!valid()) return;
      // Refresh may replace an idle queue. Acknowledgement only confirms the sent snapshot.
      const adopt = mode === "refresh" && !this.#playbackActive;
      const local = adopt ? server : this.#state();
      const localRevision = this.#revision;
      try {
        const { written } = await storage.queue.save({
          ...local,
          tracks: [...local.tracks],
          account,
          server,
          updatedAt: this.#updatedAt,
        });
        if (!valid()) return;
        if (!written) {
          this.#storageError = new Error(
            "A newer queue is already stored. The server snapshot was not saved.",
          );
          return;
        }
        this.#memory.serverQueue = server;
        this.#storageError = undefined;
        if (revision === this.#revision) this.#dirty = false;
        if (localRevision === this.#revision) this.#needsPersist = false;
        if (adopt && !this.#playbackActive) {
          this.#serverWritable = true;
          this.#publish(server);
        }
      } catch (error) {
        if (valid()) this.#storageError = error;
      }
    });
    this.#localWrites = write.catch(() => {});
    return write;
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
    await this.#writeServer();
  }
  setConnection(connection: QueueConnection | undefined) {
    if (this.#destroyed || connection === this.#connection) return;
    this.#connection = connection;
    this.#refreshPending = undefined;
    this.#serverWrites = Promise.resolve();
    this.#error = undefined;
    this.#epoch++;
    // Only edits made on this connection may be uploaded.
    this.#dirty = false;
    this.#serverWritable = false;
    this.#clearTimers();
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
