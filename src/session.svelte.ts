import { getAccountKey, type Auth, type AuthStore } from "./auth";
import type { Covers } from "./covers.svelte";
import {
  type ActiveNetworkConnection,
  type LibraryProgress,
  type Network,
  type NetworkConnection,
} from "./network.svelte";
import type { Playback } from "./playback.svelte";
import type { Playlists } from "./playlists.svelte";
import type { Account, ConnectionStatus } from "./schema";
import type { TrackEngine } from "./track.svelte";
import { Cache } from "./cache.svelte";
import { AuthWorkflow, type AuthenticatedConnection, type LoginMethod } from "./auth.svelte";
import { connectionError } from "./errors";

const offlineModeStorageKey = "navidrome-offline-mode";

interface SessionOptions {
  selection: { cache: Cache | undefined };
  network: Network;
  auth: AuthStore;
  covers: Covers;
  tracks: TrackEngine;
  playback: Playback;
  playlists?: Playlists;
  preferences: Storage;
}

export class Session {
  auth = $state.raw<Auth | null>(null);
  status = $state<ConnectionStatus>("disconnected");
  error = $state("");
  localReady = $state(false);
  loadingAfterConnect = $state(false);
  readonly login: AuthWorkflow;

  #options: SessionOptions;
  #account?: Readonly<Account>;
  #connection?: ActiveNetworkConnection;
  #libraryProgress = $state.raw<LibraryProgress>();
  #syncState = $state<"idle" | "automatic" | "manual">("idle");
  #refreshError = $state.raw<unknown>();
  #refreshPending?: Promise<void>;
  #restoration: Promise<void> = Promise.resolve();
  #loadController?: AbortController;
  #operationId = 0;
  #started = false;
  #destroyed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.login = new AuthWorkflow(
      options.network,
      () => !this.auth && this.status !== "connecting" && !this.#destroyed,
    );
  }

  get libraryProgress() {
    return this.#libraryProgress;
  }

  get syncing() {
    return this.#syncState !== "idle";
  }

  /** Explicit refresh operation, including its follow-on server sync. */
  get refreshing() {
    return this.#syncState === "manual";
  }

  get refreshError() {
    const error =
      this.#refreshError ??
      this.#options.playback.queueError ??
      this.#options.playlists?.error ??
      this.#options.selection.cache?.error;
    return error ? `Synchronization failed: ${connectionError(error)}` : "";
  }

  get busy() {
    return this.status === "connecting" || this.login.busy;
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
    this.login.cancel();
    this.loadingAfterConnect = false;
    this.#libraryProgress = undefined;
    this.#refreshPending = undefined;
    this.#syncState = "idle";
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
    this.#options.playlists?.setConnection(connection?.playlists);
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
    await this.#resumeOnline(operationId);
    if (this.#isCurrentOperation(operationId)) await this.#refresh(false);
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

  /** Load local data for a verified identity without selecting the account.
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

  /** Cancel login and workspace preparation, never the selected offline workspace.
   * Method changes delegate to Auth's discovery-preserving cancellation. */
  cancelConnect(options: { method: LoginMethod } | { resetDiscovery?: boolean } = {}) {
    if (this.auth || this.#destroyed) return;
    this.#beginOperation();
    this.status = "disconnected";
    if ("method" in options) this.login.setMethod(options.method);
    else this.login.cancel(options.resetDiscovery);
  }

  /** Accept auth's verified result, then activate local resources. Sync is background work. */
  async connect(verified: AuthenticatedConnection | undefined): Promise<boolean> {
    if (
      !verified ||
      this.auth ||
      this.status === "connecting" ||
      this.#destroyed ||
      verified.connection.signal.aborted
    )
      return false;
    const operationId = this.#beginOperation();
    this.status = "connecting";
    const { auth, connection } = verified;
    try {
      connection.signal.throwIfAborted();
      await this.#restoration;
      if (!this.#isCurrentOperation(operationId)) return false;
      const cache = await this.#prepareWorkspace(connection);
      await this.#retireWorkspace(cache, connection.signal);
      if (!this.#isCurrentOperation(operationId)) return false;
      this.#commitWorkspace(cache, auth, connection);
      this.status = "connected";
      this.loadingAfterConnect = true;
      this.login.cancel();
      void this.#refresh(false);
      return true;
    } catch (error) {
      if (this.#isCurrentOperation(operationId) && !connection.signal.aborted) {
        // Also remove partially saved credentials if browser persistence failed.
        if (this.disconnect()) this.#fail(error, this.#operationId);
      }
      return false;
    } finally {
      if (this.#isCurrentOperation(operationId) && this.status === "connecting")
        this.status = "disconnected";
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

  async #resumeOnline(operationId: number) {
    const auth = this.auth;
    if (!auth) return;
    let verified: AuthenticatedConnection;
    try {
      verified = await this.login.resume(auth);
    } catch (error) {
      if (!this.#isCurrentOperation(operationId) || this.auth !== auth) return;
      if (auth.credentials.method === "apiKey") {
        // An unverified key must not enable access to another account's cached IDs.
        this.#options.network.setMode("offline");
        throw new Error(
          `${connectionError(error)} Your saved library is available offline. Turn off Offline library to retry, or disconnect and sign in again.`,
        );
      }
      throw error;
    }
    if (!this.#isCurrentOperation(operationId) || this.auth !== auth) return;
    const { connection } = verified;
    connection.signal.throwIfAborted();
    this.#setConnection(this.#options.network.accept(connection));
    this.status = "connected";
  }

  async refresh() {
    if (!this.auth || this.offlineMode || this.busy || this.#destroyed) return;
    this.error = "";
    if (!this.#connection) {
      const operationId = this.#beginOperation();
      this.status = "connecting";
      try {
        await this.#resumeOnline(operationId);
        if (!this.#isCurrentOperation(operationId)) return;
      } catch (error) {
        this.#fail(error, operationId);
        return;
      }
    }
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
    const library = await connection.readLibrary(connection.signal, (progress) => {
      if (canPublish()) this.#libraryProgress = progress;
    });
    if (!canPublish()) return;
    await cache.replaceLibrary(
      { ...library, lastModified: modified, savedAt: Date.now() },
      connection.signal,
    );
  }

  #refresh(force: boolean): Promise<void> {
    if (this.#refreshPending) return this.#refreshPending;
    const operationId = this.#operationId;
    const { covers, playback } = this.#options;
    this.#syncState = force ? "manual" : "automatic";
    this.#libraryProgress = undefined;
    this.#refreshError = undefined;
    return (this.#refreshPending = (async () => {
      try {
        try {
          await this.#refreshLibrary(force, operationId);
        } finally {
          // Only the owning operation can reveal content after an explicit connect.
          // Artwork, playlists and queue synchronization must not block the library.
          if (this.#isCurrentOperation(operationId)) this.loadingAfterConnect = false;
        }
        if (!this.#isCurrentOperation(operationId)) return;
        this.error = "";
        await covers.refresh(force);
      } catch (error) {
        if (this.#isCurrentOperation(operationId)) this.#refreshError = error;
      }
      if (!this.#isCurrentOperation(operationId)) return;
      try {
        await this.#options.playlists?.refresh();
      } catch (error) {
        if (this.#isCurrentOperation(operationId)) this.#refreshError ??= error;
      }
      if (!this.#isCurrentOperation(operationId)) return;
      try {
        await playback.refreshQueue();
      } catch (error) {
        if (this.#isCurrentOperation(operationId)) this.#refreshError ??= error;
      }
    })().finally(() => {
      if (!this.#isCurrentOperation(operationId)) return;
      // Keep final scan counts until all sync work settles, then publish completion together.
      this.#libraryProgress = undefined;
      this.#syncState = "idle";
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
      await this.#resumeOnline(operationId);
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
