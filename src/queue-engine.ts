import * as v from "valibot";
import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";

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
  #index = -1;
  #position = 0;
  #tracks: readonly string[] = [];
  #dirty = false;
  #needsPersist = false;
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
  get current() {
    this.#subscribe();
    return this.#tracks[this.#index];
  }
  get index() {
    this.#subscribe();
    return this.#index;
  }
  get error() {
    this.#subscribe();
    return this.#error;
  }
  get storageError() {
    this.#subscribe();
    return this.#storageError;
  }
  get position() {
    this.#subscribe();
    return this.#position;
  }
  get status() {
    this.#subscribe();
    return this.#status;
  }
  get tracks() {
    this.#subscribe();
    return this.#tracks;
  }

  #publish(state: QueueState) {
    this.#tracks = [...state.tracks];
    const index = state.index ?? -1;
    this.#index = Number.isInteger(index) && index >= 0 && index < this.#tracks.length ? index : -1;
    this.#position =
      this.#index >= 0 && Number.isFinite(state.position) ? Math.max(0, state.position) : 0;
    this.#notify();
  }
  #state() {
    return { tracks: this.#tracks, index: this.#index, position: this.#position };
  }
  async #directory() {
    return (await navigator.storage.getDirectory()).getDirectoryHandle("queue", { create: true });
  }
  async #fileName(account: Account) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope(account)));
    return `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
  }
  async #read(account: Account) {
    const directory = await this.#directory();
    try {
      const file = await (await directory.getFileHandle(await this.#fileName(account))).getFile();
      return parseRecord(JSON.parse(await file.text()), account);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  #persist(): Promise<void> {
    if (!this.#account || (!this.#loaded && !this.#dirty) || !this.#needsPersist)
      return this.#localWrites.then(() => {});
    const account = this.#account;
    const revision = this.#revision;
    const record: QueueRecord = {
      account,
      tracks: [...this.#tracks],
      index: this.#index,
      position: this.#position,
      pendingSync: this.#dirty,
      updatedAt: this.#updatedAt,
    };
    const write = async () => {
      const previous = await this.#read(account).catch(() => null);
      if (previous && previous.updatedAt > record.updatedAt) return;
      const directory = await this.#directory();
      const name = await this.#fileName(account);
      const handle = await directory.getFileHandle(name, { create: true });
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await handle.createWritable();
        await writable.write(JSON.stringify(parseRecord(record, account)));
        await writable.close();
      } catch (error) {
        await writable?.abort().catch(() => {});
        if ((await handle.getFile()).size === 0) await directory.removeEntry(name).catch(() => {});
        throw error;
      }
    };
    const result = this.#localWrites
      .then(async () => {
        const name = await this.#fileName(account);
        if (navigator.locks) await navigator.locks.request(`music-web-queue:${name}`, write);
        else await write();
      })
      .then(() => {
        if (this.#account === account) {
          this.#storageError = undefined;
          if (revision === this.#revision && record.pendingSync === this.#dirty)
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
    this.#updatedAt = 0;
    this.#error = undefined;
    this.#storageError = undefined;
    this.#status = "idle";
    if (this.#client && scope(this.#client) !== scope(account)) this.#client = undefined;
    this.#publish({ tracks: [], position: 0 });
    return (this.#ready = (async () => {
      try {
        const name = await this.#fileName(account);
        const read = () => this.#read(account);
        const record = navigator.locks
          ? await navigator.locks.request(`music-web-queue:${name}`, read)
          : await read();
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
        queue.current === this.#tracks[this.#index] &&
        queue.tracks.length === this.#tracks.length &&
        queue.tracks.every((id, index) => id === this.#tracks[index]);
      this.#publish({
        tracks: queue.tracks,
        index: sameSelection
          ? this.#index
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
    if (this.#index < 0 || !Number.isFinite(position)) return;
    position = Math.max(0, position);
    if (position === this.#position) return;
    this.#position = position;
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
