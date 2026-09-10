import type { CoverEngine } from "./cover.svelte";
import type { MetadataEngine } from "./metadata.svelte";
import type { QueueEngine } from "./queue.svelte";
import type { MetadataConnection, QueueConnection, RemoteQueue } from "./network.svelte";
import type { Immutable } from "./memory.svelte";
import type { MetadataSnapshot, QueueSnapshot } from "./storage";

async function readMetadataSnapshot(
  connection: MetadataConnection,
  lastModified: number | null,
  signal: AbortSignal,
): Promise<MetadataSnapshot> {
  signal.throwIfAborted();
  const library = await connection.readLibrary(signal);
  signal.throwIfAborted();
  return { ...library, account: connection.account, lastModified, savedAt: Date.now() };
}

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
  metadata: Pick<MetadataEngine, "prepareRefresh">;
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
  #metadataConnection?: MetadataConnection;
  #metadataController?: AbortController;
  #candidateController?: AbortController;
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

  start(queueConnection: QueueConnection, metadataConnection?: MetadataConnection) {
    this.stop();
    this.#queueConnection = queueConnection;
    this.#metadataConnection = metadataConnection;
    this.#enabled = true;
    this.#options.queue.setSync(queueConnection.account, () => this.writeQueue());
  }

  // Session aborts/detaches network capabilities; invalidate orchestration here.
  stop() {
    this.#enabled = false;
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    this.#metadataController?.abort();
    this.#metadataController = undefined;
    this.#metadataConnection = undefined;
    this.#options.queue.setSync();
    this.#serverWrites = Promise.resolve();
    this.#generation++;
    this.#pending = undefined;
    this.#queuePending = undefined;
    this.#queueConnection = undefined;
    this.#syncing = false;
    this.#error = undefined;
  }

  /** Fetch a candidate without changing the selected workspace or its local snapshot. */
  async prepareConnection(connection: MetadataConnection): Promise<MetadataSnapshot> {
    this.#candidateController?.abort();
    const controller = new AbortController();
    this.#candidateController = controller;
    const signal = AbortSignal.any([connection.signal, controller.signal]);
    try {
      signal.throwIfAborted();
      const modified = await connection.getModifiedAt();
      return await readMetadataSnapshot(connection, modified, signal);
    } finally {
      controller.abort();
      if (this.#candidateController === controller) this.#candidateController = undefined;
    }
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

  async #refreshMetadata(force: boolean, current: () => boolean) {
    const connection = this.#metadataConnection;
    if (!connection || connection.signal.aborted || !current()) return;
    const prepared = await this.#options.metadata.prepareRefresh(connection.account);
    if (!prepared) return;
    if (!current()) {
      prepared.finish();
      return;
    }
    const controller = new AbortController();
    controller.signal.addEventListener("abort", prepared.finish, { once: true });
    this.#metadataController = controller;
    const signal = AbortSignal.any([controller.signal, connection.signal, prepared.signal]);
    const valid = () => current() && !signal.aborted;
    try {
      if (!valid()) return;
      const existing = prepared.existing;
      const modified =
        (await connection.getModifiedAt(existing?.lastModified ?? undefined)) ??
        existing?.lastModified ??
        null;
      if (!valid()) return;
      if (!force && existing && modified !== null && modified === existing.lastModified) return;
      const snapshot = await readMetadataSnapshot(connection, modified, signal);
      if (!valid()) return;
      await prepared.commit(snapshot, valid);
    } catch (error) {
      if (valid()) throw error;
    } finally {
      controller.abort();
      if (this.#metadataController === controller) this.#metadataController = undefined;
    }
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
        await this.#refreshMetadata(force, valid);
        if (!valid()) return;
        await this.#options.covers.refresh();
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
