import type { CoverEngine } from "./cover.svelte";
import type { MetadataEngine } from "./metadata.svelte";
import type { QueueEngine } from "./queue.svelte";

interface SyncOptions {
  metadata: Pick<MetadataEngine, "refresh" | "revalidate" | "status" | "error" | "warning">;
  covers: Pick<CoverEngine, "refresh">;
  queue: Pick<QueueEngine, "synchronize" | "error" | "storageError">;
}

/** Coordinates background work; domain engines own persistence and publication. */
export class SyncEngine {
  #options: SyncOptions;
  #enabled = false;
  #generation = 0;
  #pending?: Promise<void>;
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

  start() {
    this.stop();
    this.#enabled = true;
  }

  // Session aborts/detaches network capabilities; invalidate orchestration here.
  stop() {
    this.#enabled = false;
    this.#generation++;
    this.#pending = undefined;
    this.#syncing = false;
    this.#error = undefined;
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
      try {
        const { queue } = this.#options;
        await queue.synchronize();
        if (valid()) this.#error ??= queue.error ?? queue.storageError;
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
