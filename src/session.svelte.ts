import { getAccountKey, type Auth, type AuthStore } from "./auth";
import type { CoverEngine } from "./cover.svelte";
import {
  NetworkTransportError,
  type ActiveNetworkConnection,
  type LibraryProgress,
  type MetadataConnection,
  type Network,
  type NetworkConnection,
  type PasswordAuth,
} from "./network.svelte";
import type { PlaybackController } from "./playback-controller.svelte";
import type { QueueEngine } from "./queue.svelte";
import type { Account, ConnectionStatus } from "./schema";
import type { TrackEngine } from "./track.svelte";
import { Cache, type LibrarySnapshot } from "./cache.svelte";

const offlineModeStorageKey = "navidrome-offline-mode";

interface SessionOptions {
  selection: { cache: Cache | undefined };
  network: Network;
  auth: AuthStore;
  covers: CoverEngine;
  queue: QueueEngine;
  tracks: TrackEngine;
  playback: PlaybackController;
  preferences: Storage;
}

function connectionError(error: unknown): string {
  if (error instanceof AggregateError)
    return error.errors.length ? error.errors.map(connectionError).join("; ") : error.message;
  if (error instanceof NetworkTransportError)
    return "Could not reach the server. Check your connection, server address, and CORS settings.";
  return error instanceof Error ? error.message : "Could not connect to the server.";
}

export class Session {
  auth = $state.raw<Auth | null>(null);
  status = $state<ConnectionStatus>("disconnected");
  error = $state("");
  localReady = $state(false);

  #options: SessionOptions;
  #account?: Readonly<Account>;
  #connection?: ActiveNetworkConnection;
  #libraryProgress = $state.raw<LibraryProgress>();
  #syncing = $state(false);
  #refreshError = $state.raw<unknown>();
  #refreshPending?: Promise<void>;
  #restoration: Promise<void> = Promise.resolve();
  #loadController?: AbortController;
  #generation = 0;
  #started = false;
  #destroyed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  get libraryProgress() {
    return this.#libraryProgress;
  }

  get syncing() {
    return this.#syncing;
  }

  get refreshError() {
    const error =
      this.#refreshError ?? this.#options.queue.error ?? this.#options.selection.cache?.error;
    return error ? `Synchronization failed: ${connectionError(error)}` : "";
  }

  get busy() {
    return this.status === "connecting";
  }

  get offlineMode() {
    return this.#options.network.mode === "offline";
  }

  #valid(generation: number) {
    return !this.#destroyed && generation === this.#generation;
  }

  #begin() {
    this.error = "";
    this.#libraryProgress = undefined;
    return ++this.#generation;
  }

  #fail(error: unknown, generation: number) {
    if (!this.#valid(generation)) return;
    this.status = "error";
    this.error = connectionError(error);
  }

  #detach() {
    this.#libraryProgress = undefined;
    this.#refreshPending = undefined;
    this.#syncing = false;
    this.#refreshError = undefined;
    this.#options.network.setMode("offline");
    this.#setConnection(undefined);
    this.#options.playback.suspendNetwork();
    void this.#options.queue.flush();
  }

  /** Publish connection changes in one place; Network owns their shared abort signal. */
  #setConnection(connection: ActiveNetworkConnection | undefined) {
    this.#connection = connection;
    const { queue, covers, tracks } = this.#options;
    queue.setConnection(connection?.queue);
    covers.setConnection(connection?.artwork);
    tracks.setConnection(connection?.audio);
  }

  /** Select local data before activating resources; queue activation waits for hydration. */
  #select(cache: Cache, account: Account) {
    this.localReady = false;
    this.#account = { host: account.host, username: account.username };
    this.#options.selection.cache = cache;
    this.#options.covers.activate();
    this.#options.tracks.activate();
  }

  start(): Auth | null {
    if (this.#started || this.#destroyed) return this.auth;
    this.#started = true;
    const generation = this.#begin();
    try {
      try {
        this.auth = this.#options.auth.load();
      } catch {
        this.#options.auth.clear();
      }
      const account = this.auth
        ? { host: this.auth.host, username: this.auth.username }
        : this.#options.auth.loadAccount();
      const offlineMode =
        !this.auth || this.#options.preferences.getItem(offlineModeStorageKey) === "true";
      this.#detach();
      this.#options.network.setMode(offlineMode ? "offline" : "online");
      if (this.offlineMode) this.#options.preferences.setItem(offlineModeStorageKey, "true");
      if (account) {
        // Migrate existing installations before credentials can be removed.
        this.#options.auth.saveAccount(account);
        this.#restoration = this.#restore(account);
        if (this.auth) this.status = "connecting";
        void this.#restoration
          .then(async () => {
            if (!this.#valid(generation)) return;
            if (this.auth && !this.offlineMode) {
              this.#resumeOnline(generation);
              await this.#refresh(false);
            } else this.status = "disconnected";
          })
          .catch((error) => this.#fail(error, generation));
      } else this.localReady = true;
    } catch (error) {
      this.#fail(error, generation);
    }
    return this.auth;
  }

  async #restore(account: Account) {
    const { covers, queue, selection } = this.#options;
    const cache = new Cache(getAccountKey(account));
    this.#select(cache, account);
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;
    const current = () => !this.#destroyed && selection.cache === cache;
    try {
      await cache.load(controller.signal).catch((error) => {
        // Cache failures stay reactive and are reported through refreshError.
        if (current() && !controller.signal.aborted && !(error instanceof AggregateError))
          this.error = `Could not restore cache: ${connectionError(error)}`;
      });
      if (!current()) return;
      // Notify playback only after the cache's independent load attempts finish.
      queue.activate();
      if (current()) await covers.refresh();
      if (current()) this.localReady = true;
    } finally {
      if (this.#loadController === controller) this.#loadController = undefined;
    }
  }

  /** Prepare durable local data without publishing credentials or a new selection.
   * Same-account reconnects deliberately reuse the live writer to retain queue edits. */
  async #prepareWorkspace(connection: NetworkConnection, generation: number) {
    const modified = await connection.metadata.getModifiedAt();
    const library = await this.#readLibrary(connection.metadata, modified, generation);
    connection.signal.throwIfAborted();
    const previous = this.#options.selection.cache;
    const key = getAccountKey(connection.account);
    const cache = previous?.key === key ? previous : new Cache(key);
    // Fresh metadata repairs library read failures; other documents remain independent.
    await cache.load(connection.signal).catch((error) => {
      if (!(error instanceof AggregateError)) throw error;
    });
    connection.signal.throwIfAborted();
    await cache.replaceLibrary(library, connection.signal);
    connection.signal.throwIfAborted();
    await cache.flush();
    connection.signal.throwIfAborted();
    return cache;
  }

  /** Quiesce old resources and drain edits before committing a different account.
   * Keep the old cache selected and writable if persistence or acceptance fails. */
  async #retireWorkspace(next: Cache, signal: AbortSignal) {
    signal.throwIfAborted();
    const { selection, playback, covers, tracks } = this.#options;
    const previous = selection.cache;
    if (!previous || previous === next) return;
    playback.suspend();
    covers.activate();
    tracks.activate();
    do {
      await previous.flush();
      signal.throwIfAborted();
    } while (previous.dirty);
  }

  /** No awaits: credentials, selection and engine connections commit in one turn.
   * Storage is not transactional; connect's failure path clears partial credentials. */
  #commitWorkspace(cache: Cache, credentials: Auth, connection: NetworkConnection) {
    connection.signal.throwIfAborted();
    const { auth, preferences, network, playback, selection, queue } = this.#options;
    auth.save(credentials);
    auth.saveAccount(connection.account);
    preferences.setItem(offlineModeStorageKey, "false");
    const active = network.accept(connection);
    if (!selection.cache || selection.cache === cache) playback.suspend();
    this.#setConnection(undefined);
    this.#select(cache, connection.account);
    queue.activate();
    this.auth = credentials;
    this.#setConnection(active);
    this.localReady = true;
  }

  async connect(input: PasswordAuth): Promise<boolean> {
    if (this.auth || this.busy || this.#destroyed) return false;
    const generation = this.#begin();
    this.status = "connecting";
    try {
      const credentials = this.#options.network.createAuth(input);
      const connection = this.#options.network.prepare(credentials);
      await this.#restoration;
      if (!this.#valid(generation)) return false;
      const cache = await this.#prepareWorkspace(connection, generation);
      await this.#retireWorkspace(cache, connection.signal);
      if (!this.#valid(generation)) return false;
      this.#commitWorkspace(cache, credentials, connection);
      await this.#options.covers.refresh();
      if (!this.#valid(generation)) return false;
      await this.#options.queue.refresh();
      if (!this.#valid(generation)) return false;
      this.status = "connected";
      return true;
    } catch (error) {
      if (this.#valid(generation)) {
        // Also remove partially saved credentials if browser persistence failed.
        if (this.disconnect()) this.#fail(error, this.#generation);
      }
      return false;
    }
  }

  disconnect() {
    if (this.#destroyed) return false;
    const generation = this.#begin();
    this.auth = null;
    this.#detach();
    this.status = "disconnected";
    try {
      this.#options.auth.clear();
      this.#options.preferences.setItem(offlineModeStorageKey, "true");
      if (this.#account) this.#options.auth.saveAccount(this.#account);
      return true;
    } catch (error) {
      this.#fail(error, generation);
      return false;
    }
  }

  #resumeOnline(generation: number) {
    if (!this.auth || !this.#valid(generation)) return;
    this.#setConnection(this.#options.network.open(this.auth));
    this.status = "connected";
  }

  async refresh() {
    if (!this.auth || this.offlineMode || this.busy || this.#destroyed) return;
    this.error = "";
    await this.#refresh(true);
  }

  /** Fetch only: candidate acceptance and active-cache publication stay separate. */
  async #readLibrary(
    connection: MetadataConnection,
    lastModified: number | null,
    generation: number,
  ): Promise<LibrarySnapshot> {
    const check = () => {
      connection.signal.throwIfAborted();
      if (!this.#valid(generation)) throw new DOMException("Session superseded.", "AbortError");
    };
    check();
    this.#libraryProgress = { albums: 0, tracks: 0 };
    try {
      const library = await connection.readLibrary(connection.signal, (progress) => {
        if (this.#valid(generation) && !connection.signal.aborted) this.#libraryProgress = progress;
      });
      check();
      return { ...library, lastModified, savedAt: Date.now() };
    } finally {
      if (this.#valid(generation)) this.#libraryProgress = undefined;
    }
  }

  async #refreshLibrary(force: boolean, generation: number) {
    const connection = this.#connection?.metadata;
    const cache = this.#options.selection.cache;
    if (!connection || connection.signal.aborted) return;
    if (!cache || cache.key !== getAccountKey(connection.account))
      throw new Error("Select the account cache before refreshing metadata.");
    const current = () =>
      this.#valid(generation) &&
      !connection.signal.aborted &&
      cache === this.#options.selection.cache;
    const modified =
      (await connection.getModifiedAt(cache.lastModified ?? undefined)) ??
      cache.lastModified ??
      null;
    if (!current()) return;
    if (
      !force &&
      cache.savedAt !== undefined &&
      modified !== null &&
      modified === cache.lastModified
    )
      return;
    const library = await this.#readLibrary(connection, modified, generation);
    if (current()) await cache.replaceLibrary(library, connection.signal);
  }

  #refresh(force: boolean): Promise<void> {
    if (this.#refreshPending) return this.#refreshPending;
    const generation = this.#generation;
    const { covers, queue } = this.#options;
    this.#syncing = true;
    this.#refreshError = undefined;
    return (this.#refreshPending = (async () => {
      try {
        await this.#refreshLibrary(force, generation);
        if (!this.#valid(generation)) return;
        this.error = "";
        await covers.refresh(force);
      } catch (error) {
        if (this.#valid(generation)) this.#refreshError = error;
      }
      if (!this.#valid(generation)) return;
      try {
        await queue.refresh();
      } catch (error) {
        if (this.#valid(generation)) this.#refreshError ??= error;
      }
    })().finally(() => {
      if (this.#valid(generation)) {
        this.#syncing = false;
        this.#refreshPending = undefined;
      }
    }));
  }

  async setOfflineMode(enabled: boolean) {
    if (!this.auth || this.#destroyed || enabled === this.offlineMode) return;
    const generation = this.#begin();
    if (!enabled) this.#options.network.setMode("online");
    try {
      if (enabled) {
        this.#detach();
        this.status = "disconnected";
      }
      this.#options.preferences.setItem(offlineModeStorageKey, String(enabled));
      if (!enabled) {
        await this.#restoration;
        if (this.#valid(generation)) this.#resumeOnline(generation);
      }
    } catch (error) {
      this.#fail(error, generation);
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#generation++;
    this.#loadController?.abort();
    this.#loadController = undefined;
    this.#detach();
  }
}
