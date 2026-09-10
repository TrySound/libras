import type { CoverEngine } from "./cover.svelte";
import type { MetadataEngine } from "./metadata.svelte";
import type { QueueEngine } from "./queue.svelte";
import type { QueueConnection, RemoteQueue } from "./network.svelte";
import type { Immutable } from "./memory.svelte";
import type { QueueSnapshot } from "./storage";

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

interface SyncOptions {
  metadata: Pick<MetadataEngine, "refresh" | "revalidate" | "status" | "error" | "warning">;
  covers: Pick<CoverEngine, "refresh">;
  queue: Pick<
    QueueEngine,
    "setSync" | "prepareServerWrite" | "prepareServerUpdate" | "storageError"
  >;
}

/** Coordinates background work; domain engines own persistence and publication. */
export class SyncEngine {
  #options: SyncOptions;
  #enabled = false;
  #generation = 0;
  #pending?: Promise<void>;
  #queuePending?: Promise<void>;
  #serverWrites: Promise<void> = Promise.resolve();
  #queueConnection?: QueueConnection;
  #syncing = $state(false);
  #error = $state.raw<unknown>();

  constructor(options: SyncOptions) {
    this.#options = options;
  }

  get syncing() {
    return this.#syncing;
  }

  get error() {
    return this.#error;
  }

  start(queueConnection: QueueConnection) {
    this.stop();
    this.#queueConnection = queueConnection;
    this.#enabled = true;
    this.#options.queue.setSync(queueConnection.account, () => this.writeQueue());
  }

  // Session aborts/detaches network capabilities; invalidate orchestration here.
  stop() {
    this.#enabled = false;
    this.#options.queue.setSync();
    this.#serverWrites = Promise.resolve();
    this.#generation++;
    this.#pending = undefined;
    this.#queuePending = undefined;
    this.#queueConnection = undefined;
    this.#syncing = false;
    this.#error = undefined;
  }

  writeQueue(): Promise<void> {
    const connection = this.#queueConnection;
    const generation = this.#generation;
    const valid = () =>
      this.#enabled &&
      generation === this.#generation &&
      !!connection &&
      !connection.signal.aborted;
    const task = this.#serverWrites.then(async () => {
      if (!connection || !valid()) return;
      try {
        const prepared = await this.#options.queue.prepareServerWrite(connection.account, valid);
        if (!prepared || !valid()) return;
        this.#error = undefined;
        await connection.write(toRemoteQueue(prepared.queue));
        if (!valid()) return;
        await prepared.commit();
        if (valid()) this.#error = this.#options.queue.storageError;
      } catch (error) {
        if (valid()) this.#error = error;
      }
    });
    this.#serverWrites = task;
    return task;
  }

  refreshQueue(): Promise<void> {
    const connection = this.#queueConnection;
    if (!this.#enabled || !connection || connection.signal.aborted) return Promise.resolve();
    if (this.#queuePending) return this.#queuePending;
    const generation = this.#generation;
    const valid = () =>
      this.#enabled && generation === this.#generation && !connection.signal.aborted;
    return (this.#queuePending = (async () => {
      try {
        const { queue } = this.#options;
        await this.writeQueue();
        if (!valid()) return;
        const prepared = await queue.prepareServerUpdate(connection.account, valid);
        if (!prepared || !valid()) return;
        const remote = await connection.read();
        if (!valid()) return;
        await prepared.commit(fromRemoteQueue(remote, prepared.queue));
        if (valid()) this.#error ??= queue.storageError;
      } catch (error) {
        if (valid()) this.#error ??= error;
      }
    })().finally(() => {
      if (generation === this.#generation) this.#queuePending = undefined;
    }));
  }

  refresh(force = true): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const valid = () => this.#enabled && generation === this.#generation;
    this.#syncing = true;
    this.#error = undefined;
    return (this.#pending = (async () => {
      try {
        const { metadata, covers } = this.#options;
        if (force) await metadata.refresh();
        else await metadata.revalidate();
        if (!valid()) return;
        await covers.refresh();
        if (valid()) this.#error = metadata.status === "error" ? metadata.error : metadata.warning;
      } catch (error) {
        if (valid()) this.#error = error;
      }
      if (!valid()) return;
      await this.refreshQueue();
    })().finally(() => {
      if (valid()) {
        this.#syncing = false;
        this.#pending = undefined;
      }
    }));
  }
}
