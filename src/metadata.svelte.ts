import type { MetadataConnection } from "./network.svelte";
import type { Memory } from "./memory.svelte";
import type { Cache, LibrarySnapshot } from "./cache.svelte";
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
  #memory: Pick<Memory, "cache">;
  #connection?: MetadataConnection;
  #restored = false;
  #restoring?: Promise<void>;
  #generation = 0;
  #updateController?: AbortController;
  #candidateController?: AbortController;
  #localController?: AbortController;
  #destroyed = false;

  constructor(memory: Pick<Memory, "cache">) {
    this.#memory = memory;
  }

  get savedAt() {
    return this.#memory.cache?.savedAt;
  }

  #invalidate() {
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    this.#updateController?.abort();
    this.#updateController = undefined;
    this.#localController?.abort();
    this.#localController = undefined;
    return ++this.#generation;
  }

  // Session selects a credential-free account cache before attaching network access.
  restore(cache: Cache): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    if (cache === this.#memory.cache) {
      if (this.#restoring) return this.#restoring;
      if (this.#restored) return Promise.resolve();
    }
    const generation = this.#invalidate();
    const controller = new AbortController();
    this.#localController = controller;
    this.#memory.cache = cache;
    this.#restored = false;
    return (this.#restoring = cache
      .load(controller.signal)
      .catch((error) => {
        if (generation !== this.#generation || this.#destroyed) return;
        throw error;
      })
      .finally(() => {
        if (generation !== this.#generation || this.#destroyed) return;
        this.#restoring = undefined;
        this.#localController = undefined;
        this.#restored = true;
      }));
  }

  setConnection(connection: MetadataConnection | undefined) {
    if (this.#destroyed) return;
    this.#candidateController?.abort();
    this.#candidateController = undefined;
    if (connection === this.#connection) return;
    this.#connection = connection;
    // Attaching network access must not invalidate pending local restoration.
    if (!this.#restoring) this.#invalidate();
  }

  async refresh(force = true) {
    const connection = this.#connection;
    if (this.#restoring) await this.#restoring;
    if (
      !connection ||
      connection !== this.#connection ||
      connection.signal.aborted ||
      this.#destroyed
    )
      return;
    const cache = this.#memory.cache;
    if (
      !this.#restored ||
      !cache ||
      cache.account.host !== connection.account.host ||
      cache.account.username !== connection.account.username
    )
      throw new Error("Restore the account before refreshing metadata.");
    const generation = this.#invalidate();
    const controller = new AbortController();
    this.#updateController = controller;
    const signal = AbortSignal.any([controller.signal, connection.signal]);
    const valid = () => !this.#destroyed && generation === this.#generation && !signal.aborted;
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

  /** Persist into an unselected candidate cache; acceptance is a separate synchronous step. */
  async saveConnection(
    snapshot: MetadataSnapshot,
    cache: Cache,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.#destroyed) throw new DOMException("Metadata stopped.", "AbortError");
    if (cache === this.#memory.cache)
      throw new Error("Prepare the connection in a separate cache.");
    if (
      cache.account.host !== snapshot.account.host ||
      cache.account.username !== snapshot.account.username
    )
      throw new Error("Metadata cache belongs to a different account.");
    this.#invalidate();
    const controller = new AbortController();
    this.#localController = controller;
    try {
      const { account: _account, ...library } = snapshot;
      await cache.replaceLibrary(library, AbortSignal.any([signal, controller.signal]));
    } finally {
      if (this.#localController === controller) this.#localController = undefined;
    }
  }

  /** Session accepts the network connection before selecting its prepared cache. */
  acceptConnection(cache: Cache) {
    if (this.#destroyed) return;
    this.#invalidate();
    this.#restoring = undefined;
    this.#restored = true;
    this.#memory.cache = cache;
  }

  destroy() {
    this.#destroyed = true;
    this.#invalidate();
  }
}
