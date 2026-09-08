import * as v from "valibot";
import { OpfsJsonStore, jsonFileName } from "./json-store";
import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";
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
export type QueueNetwork = "offline" | "online";

export class QueueEngine {
  #client?: SubsonicClient;
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
  #network: QueueNetwork = "online";
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
    if (this.#client && scope(this.#client) !== scope(account)) this.#client = undefined;
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
    const client = this.#client;
    if (!client || this.#network === "offline" || this.#destroyed) return;
    const epoch = this.#epoch;
    const revision = this.#revision;
    this.#error = undefined;
    this.#status = "loading";
    this.#update();
    try {
      const queue = await client.getPlayQueue();
      if (epoch !== this.#epoch || revision !== this.#revision || this.#destroyed) return;
      this.#dirty = false;
      this.#needsPersist = true;
      this.#updatedAt = Math.max(Date.now(), this.#updatedAt + 1);
      // Subsonic identifies the selection by ID, so retain our occurrence index
      // when an unchanged server queue contains the same track more than once.
      const sameSelection =
        queue.current === this.#memory.queueTracks[this.#memory.queueIndex] &&
        queue.tracks.length === this.#memory.queueTracks.length &&
        queue.tracks.every((id, index) => id === this.#memory.queueTracks[index]);
      this.#publish({
        tracks: queue.tracks,
        index: sameSelection
          ? this.#memory.queueIndex
          : queue.current
            ? queue.tracks.indexOf(queue.current)
            : -1,
        position: queue.position,
      });
      this.#status = "ready";
      await this.#persist();
    } catch (error) {
      if (epoch !== this.#epoch || revision !== this.#revision || this.#destroyed) return;
      this.#error = error;
      this.#status = "error";
    }
    this.#update();
  }

  #sync(): Promise<void> {
    const client = this.#client;
    const epoch = this.#epoch;
    const result = this.#serverWrites.then(async () => {
      if (
        !client ||
        epoch !== this.#epoch ||
        this.#network === "offline" ||
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
        await client.savePlayQueue({
          tracks: state.tracks,
          current: state.tracks[state.index],
          position: state.position,
        });
        if (epoch !== this.#epoch || this.#destroyed) return;
        if (revision === this.#revision) {
          this.#dirty = false;
          this.#needsPersist = true;
          await this.#persist();
        }
        if (epoch !== this.#epoch || this.#destroyed) return;
        this.#status = "ready";
      } catch (error) {
        if (epoch !== this.#epoch || this.#destroyed) return;
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
    this.#status = this.#network === "offline" ? "idle" : "ready";
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
      if (this.#network === "offline") {
        this.#status = "idle";
        this.#update();
        return;
      }
      if (this.#dirty) await this.#sync();
      else await this.#load();
    })();
    this.#connecting = { epoch: this.#epoch, promise };
    return promise;
  }
  async setClient(client: SubsonicClient) {
    if (client === this.#client || this.#destroyed) return;
    this.#client = client;
    this.#epoch++;
    await this.restore(client);
    if (this.#client === client && !this.#destroyed) await this.#connect();
  }
  async setNetwork(network: QueueNetwork) {
    if (network === this.#network || this.#destroyed) return;
    this.#network = network;
    this.#epoch++;
    this.#clearTimers();
    // Restoration has its own account epoch; do not interrupt an initial disk read.
    await this.#ready;
    await this.#persist();
    if (!this.#destroyed) await this.#connect();
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
