import * as v from "valibot";
import { OpfsJsonStore, jsonFileName } from "./json-store";
import { createSubscriber } from "svelte/reactivity";
import type { QueueConnection } from "./network.svelte";
import type { Memory } from "./memory.svelte";

type QueueMemory = Pick<Memory, "queueTracks" | "queueIndex" | "queuePosition">;

export interface QueueState {
  index?: number;
  position: number;
  tracks: readonly string[];
}
type Account = { host: string; username: string };
const recordSchema = v.strictObject({
  account: v.strictObject({ host: v.string(), username: v.string() }),
  tracks: v.array(v.pipe(v.string(), v.minLength(1))),
  index: v.pipe(v.number(), v.integer(), v.minValue(-1)),
  position: v.pipe(v.number(), v.finite(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  pendingSync: v.boolean(),
});
type QueueRecord = v.InferOutput<typeof recordSchema>;
const scope = (account: Account) => `${account.host}\n${account.username}`;
function parseRecord(value: unknown, account: Account) {
  const record = v.parse(recordSchema, value);
  if (scope(record.account) !== scope(account))
    throw new Error("The queue belongs to a different account.");
  if (record.index >= record.tracks.length || (record.index === -1 && record.position !== 0))
    throw new Error("The saved queue selection is invalid.");
  return record;
}
export type QueueEngineStatus = "idle" | "loading" | "ready" | "saving" | "error";

export class QueueEngine {
  #connection?: QueueConnection;
  #account?: Account;
  #memory: QueueMemory;

  constructor(memory: QueueMemory) {
    this.#memory = memory;
  }
  #dirty = false;
  #needsPersist = false;
  #conflict = false;
  #files = new Map<string, Promise<OpfsJsonStore<QueueRecord>>>();
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
  #error: unknown;
  #storageError: unknown;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #localTimer?: ReturnType<typeof setTimeout>;
  #status: QueueEngineStatus = "idle";
  #listeners = new Set<() => void>();
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #notify() {
    this.#update();
    for (const listener of this.#listeners) listener();
  }
  get error() {
    this.#subscribe();
    return this.#error;
  }
  get storageError() {
    this.#subscribe();
    return this.#storageError;
  }
  get status() {
    this.#subscribe();
    return this.#status;
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
  #file({ host, username }: Account) {
    const key = `${host}\n${username}`;
    let file = this.#files.get(key);
    if (!file) {
      file = jsonFileName(key)
        .then(
          (fileName) =>
            new OpfsJsonStore({
              directory: "queue",
              fileName,
              lockName: `music-web-queue:${fileName}`,
              parse: (value) => parseRecord(value, { host, username }),
            }),
        )
        .catch((error) => {
          this.#files.delete(key);
          throw error;
        });
      this.#files.set(key, file);
    }
    return file;
  }

  #persist(): Promise<void> {
    if (!this.#account || (!this.#loaded && !this.#dirty) || !this.#needsPersist)
      return this.#localWrites.then(() => {});
    const account = this.#account;
    const revision = this.#revision;
    const record: QueueRecord = {
      account,
      tracks: [...this.#memory.queueTracks],
      index: this.#memory.queueIndex,
      position: this.#memory.queuePosition,
      pendingSync: this.#dirty,
      updatedAt: this.#updatedAt,
    };
    // Also retain an engine-wide tail so teardown waits for writes to previous accounts.
    const result = this.#localWrites
      .then(() => this.#file(account))
      .then((file) =>
        file.update(
          (previous) => (previous && previous.updatedAt > record.updatedAt ? undefined : record),
          // Preserve the queue's existing repair-on-write policy.
          { recoverReadError: () => null },
        ),
      )
      .then(({ written }) => {
        if (this.#account !== account) return;
        if (!written) {
          this.#conflict = true;
          this.#dirty = true;
          this.#storageError = new Error(
            "A newer queue was saved in another tab. This queue has not been saved.",
          );
          return;
        }
        if (revision === this.#revision && record.pendingSync === this.#dirty) {
          this.#conflict = false;
          this.#storageError = undefined;
          this.#needsPersist = false;
        }
      })
      .catch((error) => {
        if (this.#account === account) this.#storageError = error;
      })
      .finally(() => {
        if (!this.#destroyed && this.#account === account) this.#update();
      });
    this.#localWrites = result;
    return result;
  }

  restore(identity: Account): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    if (this.#account && scope(this.#account) === scope(identity)) return this.#ready;
    void this.#persist();
    this.#clearTimers();
    const account = { host: identity.host, username: identity.username };
    this.#account = account;
    this.#epoch++;
    const generation = ++this.#accountGeneration;
    const revision = ++this.#revision;
    this.#loaded = false;
    this.#dirty = false;
    this.#needsPersist = false;
    this.#conflict = false;
    this.#updatedAt = 0;
    this.#error = undefined;
    this.#storageError = undefined;
    this.#status = "idle";
    if (this.#connection && scope(this.#connection.account) !== scope(account))
      this.#connection = undefined;
    this.#publish({ tracks: [], position: 0 });
    return (this.#ready = (async () => {
      try {
        const record = await (await this.#file(account)).read();
        if (generation !== this.#accountGeneration || this.#destroyed) return;
        if (record && revision === this.#revision) {
          this.#dirty = record.pendingSync;
          this.#updatedAt = record.updatedAt;
          this.#publish(record);
        }
      } catch (error) {
        if (generation === this.#accountGeneration) this.#storageError = error;
      } finally {
        if (generation === this.#accountGeneration && !this.#destroyed) {
          this.#loaded = true;
          if (revision !== this.#revision) await this.#persist();
          this.#update();
        }
      }
    })());
  }

  async #load() {
    const connection = this.#connection;
    if (!connection || connection.signal.aborted || this.#destroyed) return;
    const epoch = this.#epoch;
    const revision = this.#revision;
    this.#error = undefined;
    this.#status = "loading";
    this.#update();
    try {
      const queue = await connection.read();
      if (
        epoch !== this.#epoch ||
        revision !== this.#revision ||
        this.#destroyed ||
        connection.signal.aborted
      )
        return;
      this.#dirty = false;
      this.#needsPersist = true;
      this.#updatedAt = Math.max(Date.now(), this.#updatedAt + 1);
      // Remote queues identify the selection by ID, so retain our occurrence index
      // when an unchanged server queue contains the same track more than once.
      const sameSelection =
        queue.currentTrackId === this.#memory.queueTracks[this.#memory.queueIndex] &&
        queue.trackIds.length === this.#memory.queueTracks.length &&
        queue.trackIds.every((id, index) => id === this.#memory.queueTracks[index]);
      this.#publish({
        tracks: queue.trackIds,
        index: sameSelection
          ? this.#memory.queueIndex
          : queue.currentTrackId
            ? queue.trackIds.indexOf(queue.currentTrackId)
            : -1,
        position: queue.position,
      });
      this.#status = "ready";
      await this.#persist();
    } catch (error) {
      if (
        epoch !== this.#epoch ||
        revision !== this.#revision ||
        this.#destroyed ||
        connection.signal.aborted
      )
        return;
      this.#error = error;
      this.#status = "error";
    }
    this.#update();
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
      this.#status = "saving";
      this.#update();
      try {
        await connection.write({
          trackIds: state.tracks,
          currentTrackId: state.tracks[state.index],
          position: state.position,
        });
        if (epoch !== this.#epoch || this.#destroyed || connection.signal.aborted) return;
        if (revision === this.#revision) {
          this.#dirty = false;
          this.#needsPersist = true;
          await this.#persist();
        }
        if (epoch !== this.#epoch || this.#destroyed || connection.signal.aborted) return;
        this.#status = "ready";
      } catch (error) {
        if (epoch !== this.#epoch || this.#destroyed || connection.signal.aborted) return;
        this.#error = error;
        this.#status = "error";
      }
      this.#update();
    });
    this.#serverWrites = result.catch(() => {});
    return result;
  }

  #changed() {
    this.#revision++;
    this.#updatedAt = Math.max(Date.now(), this.#updatedAt + 1);
    this.#dirty = true;
    this.#needsPersist = true;
  }
  update(state: QueueState) {
    this.#changed();
    this.#status = !this.#connection || this.#connection.signal.aborted ? "idle" : "ready";
    this.#publish(state);
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
    const promise = (async () => {
      if (!this.#connection || this.#connection.signal.aborted) {
        this.#status = "idle";
        this.#update();
        return;
      }
      if (this.#dirty) await this.#sync();
      else await this.#load();
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
    this.#clearTimers();
    this.#status = "idle";
    this.#update();
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
