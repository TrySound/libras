import type { CoverEngine } from "./cover.svelte";
import type { MetadataEngine } from "./metadata.svelte";
import type { QueueEngine } from "./queue.svelte";
import type { MetadataConnection, QueueConnection } from "./network.svelte";
import type { MetadataSnapshot } from "./storage";

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

interface SyncOptions {
  metadata: Pick<MetadataEngine, "setConnection" | "refresh">;
  covers: Pick<CoverEngine, "refresh">;
  queue: Pick<QueueEngine, "setConnection" | "refresh" | "error" | "storageError">;
}

/** Coordinates background work; domain engines own persistence and publication. */
export class SyncEngine {
  #options: SyncOptions;
  #enabled = false;
  #generation = 0;
  #pending?: Promise<void>;
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
    return this.#error ?? this.#options.queue.error ?? this.#options.queue.storageError;
  }

  start(queueConnection: QueueConnection, metadataConnection?: MetadataConnection) {
    this.stop();
    this.#options.metadata.setConnection(metadataConnection);
    this.#enabled = true;
    this.#options.queue.setConnection(queueConnection);
  }

  // Session aborts/detaches network capabilities; invalidate orchestration here.
  stop() {
    this.#enabled = false;
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    this.#options.metadata.setConnection(undefined);
    this.#options.queue.setConnection(undefined);
    this.#generation++;
    this.#pending = undefined;
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

  refresh(force = true): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const valid = () => this.#enabled && generation === this.#generation;
    this.#syncing = true;
    this.#error = undefined;
    return (this.#pending = (async () => {
      try {
        await this.#options.metadata.refresh(force);
        if (!valid()) return;
        await this.#options.covers.refresh();
      } catch (error) {
        if (valid()) this.#error = error;
      }
      if (!valid()) return;
      try {
        await this.#options.queue.refresh();
      } catch (error) {
        if (valid()) this.#error ??= error;
      }
    })().finally(() => {
      if (valid()) {
        this.#syncing = false;
        this.#pending = undefined;
      }
    }));
  }
}
