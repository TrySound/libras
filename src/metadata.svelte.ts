import type { MetadataConnection } from "./network.svelte";
import type { CacheSelection, LibrarySnapshot } from "./cache.svelte";
import type { Account } from "./schema";

export type MetadataSnapshot = LibrarySnapshot & { account: Readonly<Account> };

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

export class MetadataEngine {
  #selection: CacheSelection;
  #connection?: MetadataConnection;
  #generation = 0;
  #updateController?: AbortController;
  #candidateController?: AbortController;
  #destroyed = false;

  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }

  #invalidate() {
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    this.#updateController?.abort();
    this.#updateController = undefined;
    return ++this.#generation;
  }

  setConnection(connection: MetadataConnection | undefined) {
    if (this.#destroyed) return;
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
    if (
      !cache?.account ||
      cache.account.host !== connection.account.host ||
      cache.account.username !== connection.account.username
    )
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
      const snapshot = await readMetadataSnapshot(connection, modified, signal);
      if (!valid()) return;
      const { account: _account, ...library } = snapshot;
      await cache.replaceLibrary(library, signal);
    } catch (error) {
      if (valid()) throw error;
    } finally {
      controller.abort();
      if (this.#updateController === controller) this.#updateController = undefined;
    }
  }

  /** Fetch a candidate without changing the selected workspace. */
  async prepareConnection(connection: MetadataConnection): Promise<MetadataSnapshot> {
    if (this.#destroyed) throw new DOMException("Metadata stopped.", "AbortError");
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

  destroy() {
    this.#destroyed = true;
    this.#invalidate();
  }
}
