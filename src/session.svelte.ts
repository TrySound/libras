import { getAccountKey, type Auth, type AuthStore } from "./auth";
import type { CoverEngine } from "./cover.svelte";
import {
  NetworkTransportError,
  type ActiveNetworkConnection,
  type LibraryProgress,
  type Network,
  type NetworkConnection,
  type PasswordAuth,
} from "./network.svelte";
import type { Playback } from "./playback.svelte";
import type { Account, ConnectionStatus } from "./schema";
import type { TrackEngine } from "./track.svelte";
import { Cache } from "./cache.svelte";

const offlineModeStorageKey = "navidrome-offline-mode";

interface SessionOptions {
  selection: { cache: Cache | undefined };
  network: Network;
  auth: AuthStore;
  covers: CoverEngine;
  tracks: TrackEngine;
  playback: Playback;
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
  #operationId = 0;
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
      this.#refreshError ??
      this.#options.playback.queueError ??
      this.#options.selection.cache?.error;
    return error ? `Synchronization failed: ${connectionError(error)}` : "";
  }

  get busy() {
    return this.status === "connecting";
  }

  get offlineMode() {
    return this.#options.network.mode === "offline";
  }

  #isCurrentOperation(operationId: number) {
    return !this.#destroyed && operationId === this.#operationId;
  }

  #beginOperation() {
    this.error = "";
    this.#libraryProgress = undefined;
    return ++this.#operationId;
  }

  #fail(error: unknown, operationId: number) {
    if (!this.#isCurrentOperation(operationId)) return;
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
    void this.#options.playback.flushQueue();
  }

  /** Publish connection changes in one place; Network owns their shared abort signal. */
  #setConnection(connection: ActiveNetworkConnection | undefined) {
    this.#connection = connection;
    const { playback, covers, tracks } = this.#options;
    playback.setConnection(connection?.queue);
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
    const operationId = this.#beginOperation();
    try {
      this.auth = this.#loadSavedAuth();
      const account = this.auth
        ? { host: this.auth.host, username: this.auth.username }
        : this.#options.auth.loadAccount();
      const offlineMode =
        !this.auth || this.#options.preferences.getItem(offlineModeStorageKey) === "true";
      this.#detach();
      this.#options.network.setMode(offlineMode ? "offline" : "online");
      if (this.offlineMode) this.#options.preferences.setItem(offlineModeStorageKey, "true");
      if (!account) {
        this.localReady = true;
        return this.auth;
      }
      // Migrate existing installations before credentials can be removed.
      this.#options.auth.saveAccount(account);
      this.#restoration = this.#restore(account);
      if (this.auth) this.status = "connecting";
      void this.#finishStartup(operationId).catch((error) => this.#fail(error, operationId));
    } catch (error) {
      this.#fail(error, operationId);
    }
    return this.auth;
  }

  #loadSavedAuth(): Auth | null {
    try {
      return this.#options.auth.load();
    } catch {
      this.#options.auth.clear();
      return null;
    }
  }

  async #finishStartup(operationId: number) {
    await this.#restoration;
    if (!this.#isCurrentOperation(operationId)) return;
    if (!this.auth || this.offlineMode) {
      this.status = "disconnected";
      return;
    }
    this.#resumeOnline();
    await this.#refresh(false);
  }

  async #restore(account: Account) {
    const { covers, playback, selection } = this.#options;
    const cache = new Cache(getAccountKey(account));
    this.#select(cache, account);
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;
    // Local restoration survives disconnect; only its cache/lifetime can invalidate it.
    const canPublish = () =>
      !this.#destroyed && !controller.signal.aborted && selection.cache === cache;
    try {
      await cache.load(controller.signal).catch((error) => {
        // Cache failures stay reactive and are reported through refreshError.
        if (!canPublish() || error instanceof AggregateError) return;
        this.error = `Could not restore cache: ${connectionError(error)}`;
      });
      if (!canPublish()) return;
      // Notify playback only after the cache's independent load attempts finish.
      playback.activate();
      if (!canPublish()) return;
      await covers.refresh();
      if (canPublish()) this.localReady = true;
    } finally {
      if (this.#loadController === controller) this.#loadController = undefined;
    }
  }

  /** Load local data before validating credentials, without selecting the account.
   * Same-account reconnects reuse the live writer to retain queue edits. */
  async #prepareWorkspace(connection: NetworkConnection) {
    const previous = this.#options.selection.cache;
    const key = getAccountKey(connection.account);
    const cache = previous?.key === key ? previous : new Cache(key);
    // Independent cache failures remain visible after acceptance; a background
    // refresh can repair the library without making login depend on its availability.
    await cache.load(connection.signal).catch((error) => {
      if (!(error instanceof AggregateError)) throw error;
    });
    connection.signal.throwIfAborted();
    return cache;
  }

  /** Stop playback for the transition; switching caches also retires old resources
   * and drains edits. Failure leaves the old cache selected and writable. */
  async #retireWorkspace(next: Cache, signal: AbortSignal) {
    signal.throwIfAborted();
    const { selection, playback, covers, tracks } = this.#options;
    playback.suspend();
    const previous = selection.cache;
    if (!previous || previous === next) return;
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
    const { auth, preferences, network, playback } = this.#options;
    auth.save(credentials);
    auth.saveAccount(connection.account);
    preferences.setItem(offlineModeStorageKey, "false");
    const active = network.accept(connection);
    this.#setConnection(undefined);
    this.#select(cache, connection.account);
    playback.activate();
    this.auth = credentials;
    this.#setConnection(active);
    this.localReady = true;
  }

  /** Login succeeds once local data and credentials are accepted, not when sync finishes. */
  async connect(input: PasswordAuth): Promise<boolean> {
    if (this.auth || this.busy || this.#destroyed) return false;
    const operationId = this.#beginOperation();
    this.status = "connecting";
    try {
      const credentials = this.#options.network.createAuth(input);
      const connection = this.#options.network.prepare(credentials);
      await this.#restoration;
      if (!this.#isCurrentOperation(operationId)) return false;
      const cache = await this.#prepareWorkspace(connection);
      await this.#options.network.validate(connection);
      connection.signal.throwIfAborted();
      if (!this.#isCurrentOperation(operationId)) return false;
      await this.#retireWorkspace(cache, connection.signal);
      if (!this.#isCurrentOperation(operationId)) return false;
      this.#commitWorkspace(cache, credentials, connection);
      this.status = "connected";
      void this.#refresh(false);
      return true;
    } catch (error) {
      if (this.#isCurrentOperation(operationId)) {
        // Also remove partially saved credentials if browser persistence failed.
        if (this.disconnect()) this.#fail(error, this.#operationId);
      }
      return false;
    }
  }

  disconnect() {
    if (this.#destroyed) return false;
    const operationId = this.#beginOperation();
    this.auth = null;
    this.#detach();
    this.status = "disconnected";
    try {
      this.#options.auth.clear();
      this.#options.preferences.setItem(offlineModeStorageKey, "true");
      if (this.#account) this.#options.auth.saveAccount(this.#account);
      return true;
    } catch (error) {
      this.#fail(error, operationId);
      return false;
    }
  }

  #resumeOnline() {
    if (!this.auth) return;
    this.#setConnection(this.#options.network.open(this.auth));
    this.status = "connected";
  }

  async refresh() {
    if (!this.auth || this.offlineMode || this.busy || this.#destroyed) return;
    this.error = "";
    await this.#refresh(true);
  }

  async #refreshLibrary(force: boolean, operationId: number) {
    const connection = this.#connection?.metadata;
    const cache = this.#options.selection.cache;
    if (!connection || connection.signal.aborted) return;
    if (!cache || cache.key !== getAccountKey(connection.account))
      throw new Error("Select the account cache before refreshing metadata.");
    // A response belongs to this operation, connection and selected cache.
    const canPublish = () =>
      this.#isCurrentOperation(operationId) &&
      !connection.signal.aborted &&
      cache === this.#options.selection.cache;
    const modified =
      (await connection.getModifiedAt(cache.lastModified ?? undefined)) ??
      cache.lastModified ??
      null;
    if (!canPublish()) return;
    const hasSnapshot = cache.savedAt !== undefined;
    const unchanged = modified !== null && modified === cache.lastModified;
    if (!force && hasSnapshot && unchanged) return;
    this.#libraryProgress = { albums: 0, tracks: 0 };
    try {
      const library = await connection.readLibrary(connection.signal, (progress) => {
        if (canPublish()) this.#libraryProgress = progress;
      });
      if (!canPublish()) return;
      await cache.replaceLibrary(
        { ...library, lastModified: modified, savedAt: Date.now() },
        connection.signal,
      );
    } finally {
      if (this.#isCurrentOperation(operationId)) this.#libraryProgress = undefined;
    }
  }

  #refresh(force: boolean): Promise<void> {
    if (this.#refreshPending) return this.#refreshPending;
    const operationId = this.#operationId;
    const { covers, playback } = this.#options;
    this.#syncing = true;
    this.#refreshError = undefined;
    return (this.#refreshPending = (async () => {
      try {
        await this.#refreshLibrary(force, operationId);
        if (!this.#isCurrentOperation(operationId)) return;
        this.error = "";
        await covers.refresh(force);
      } catch (error) {
        if (this.#isCurrentOperation(operationId)) this.#refreshError = error;
      }
      if (!this.#isCurrentOperation(operationId)) return;
      try {
        await playback.refreshQueue();
      } catch (error) {
        if (this.#isCurrentOperation(operationId)) this.#refreshError ??= error;
      }
    })().finally(() => {
      if (!this.#isCurrentOperation(operationId)) return;
      this.#syncing = false;
      this.#refreshPending = undefined;
    }));
  }

  async setOfflineMode(enabled: boolean) {
    if (!this.auth || this.#destroyed) return;
    if (enabled === this.offlineMode) return;
    const operationId = this.#beginOperation();
    try {
      if (enabled) {
        this.#detach();
        this.status = "disconnected";
      } else {
        this.#options.network.setMode("online");
      }
      this.#options.preferences.setItem(offlineModeStorageKey, String(enabled));
      if (enabled) return;
      await this.#restoration;
      if (!this.#isCurrentOperation(operationId)) return;
      this.#resumeOnline();
    } catch (error) {
      this.#fail(error, operationId);
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#operationId++;
    this.#loadController?.abort();
    this.#loadController = undefined;
    this.#detach();
  }
}
