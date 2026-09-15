import { getAccountKey } from "./auth";
import type { LibraryProgress, MetadataConnection } from "./network.svelte";
import type { CacheSelection, LibrarySnapshot } from "./cache.svelte";
import type { Account } from "./schema";

export type MetadataSnapshot = LibrarySnapshot & { account: Readonly<Account> };

async function readMetadataSnapshot(
  connection: MetadataConnection,
  lastModified: number | null,
  signal: AbortSignal,
  onProgress: (progress: LibraryProgress) => void,
): Promise<MetadataSnapshot> {
  signal.throwIfAborted();
  const library = await connection.readLibrary(signal, onProgress);
  signal.throwIfAborted();
  return { ...library, account: connection.account, lastModified, savedAt: Date.now() };
}

export class MetadataEngine {
  #selection: CacheSelection;
  #connection?: MetadataConnection;
  #generation = 0;
  #updateController?: AbortController;
  #candidateController?: AbortController;
  #destroyed = false;
  #progress = $state.raw<LibraryProgress>();

  get progress() {
    return this.#progress;
  }

  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }

  #invalidate() {
    this.#progress = undefined;
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    this.#updateController?.abort();
    this.#updateController = undefined;
    return ++this.#generation;
  }

  setConnection(connection: MetadataConnection | undefined) {
    if (this.#destroyed) return;
    if (this.#candidateController) this.#progress = undefined;
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    if (connection === this.#connection) return;
    this.#connection = connection;
    this.#invalidate();
  }

  async refresh(force = true) {
    const connection = this.#connection;
    if (!connection || connection.signal.aborted || this.#destroyed) return;
    const cache = this.#selection.cache;
    if (!cache || cache.key !== getAccountKey(connection.account))
      throw new Error("Select the account cache before refreshing metadata.");
    const generation = this.#invalidate();
    const controller = new AbortController();
    this.#updateController = controller;
    const signal = AbortSignal.any([controller.signal, connection.signal]);
    const valid = () =>
      !this.#destroyed &&
      generation === this.#generation &&
      !signal.aborted &&
      cache === this.#selection.cache;
    try {
      const modified =
        (await connection.getModifiedAt(cache.lastModified ?? undefined)) ??
        cache.lastModified ??
        null;
      if (!valid()) return;
      if (
        !force &&
        cache.savedAt !== undefined &&
        modified !== null &&
        modified === cache.lastModified
      )
        return;
      this.#progress = { albums: 0, tracks: 0 };
      const snapshot = await readMetadataSnapshot(connection, modified, signal, (progress) => {
        if (valid()) this.#progress = progress;
      });
      if (!valid()) return;
      const { account: _account, ...library } = snapshot;
      await cache.replaceLibrary(library, signal);
    } catch (error) {
      if (valid()) throw error;
    } finally {
      controller.abort();
      if (this.#updateController === controller) {
        this.#updateController = undefined;
        this.#progress = undefined;
      }
    }
  }

  /** Fetch a candidate without changing the selected workspace. */
  async prepareConnection(connection: MetadataConnection): Promise<MetadataSnapshot> {
    if (this.#destroyed) throw new DOMException("Metadata stopped.", "AbortError");
    this.#invalidate();
    const controller = new AbortController();
    this.#candidateController = controller;
    const signal = AbortSignal.any([connection.signal, controller.signal]);
    try {
      signal.throwIfAborted();
      const modified = await connection.getModifiedAt();
      signal.throwIfAborted();
      this.#progress = { albums: 0, tracks: 0 };
      return await readMetadataSnapshot(connection, modified, signal, (progress) => {
        if (this.#candidateController === controller && !signal.aborted) this.#progress = progress;
      });
    } finally {
      controller.abort();
      if (this.#candidateController === controller) {
        this.#candidateController = undefined;
        this.#progress = undefined;
      }
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#invalidate();
  }
}
