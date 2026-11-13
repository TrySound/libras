import {
  authenticate,
  getAccountKey,
  normalizeAndValidateServerHost,
  type Auth,
  type AuthStore,
  type PasswordAuth,
} from "./auth";
import type { Covers } from "./covers.svelte";
import {
  NetworkTransportError,
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
import { withoutDownloadErrors } from "./download-error";

import { acquireAccountOwnership, AccountOwnershipError } from "./account-ownership";

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
  acquireOwnership?: typeof acquireAccountOwnership;
}

function connectionError(error: unknown): string {
  error = withoutDownloadErrors(error);
  if (error === undefined) return "";
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
  ownershipIssue = $state<"blocked" | "unsupported">();
  #ownership?: { key: string; release: () => Promise<void> };
  #restoreAccount?: Account;
  loadingAfterConnect = $state(false);

  #options: SessionOptions;
  #account?: Readonly<Account>;
  #connection?: ActiveNetworkConnection;
  #libraryProgress = $state.raw<LibraryProgress>();
  #syncState = $state<"idle" | "automatic" | "manual">("idle");
  #refreshError = $state.raw<unknown>();
  #refreshPending?: Promise<void>;
  #restoration: Promise<void> = Promise.resolve();
  #loadController?: AbortController;
  #authController?: AbortController;
  #operationId = 0;
  #started = false;
  #destroyed = false;
  #deleting?: Promise<void>;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  /** Browsing preference only; never changes playback or connection ownership. */
  downloadedOnly = $state(false);

  setDownloadedOnly(enabled: boolean) {
    this.downloadedOnly = enabled;
    this.#options.preferences.setItem("libras-downloaded-only", String(enabled));
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
      withoutDownloadErrors(this.#refreshError) ??
      withoutDownloadErrors(this.#options.playback.queueError) ??
      withoutDownloadErrors(this.#options.playlists?.error) ??
      this.#options.selection.cache?.reportingError;
    const message = connectionError(error);
    return message ? `Synchronization failed: ${message}` : "";
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
    if (error instanceof AccountOwnershipError) this.ownershipIssue = error.reason;
    this.error = connectionError(error);
    this.status = this.error ? "error" : "disconnected";
  }

  /** Detach all server access; durable queued download intent remains paused. */
  #detach() {
    this.#authController?.abort();
    this.#authController = undefined;
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
    if (
      connection &&
      (this.#ownership?.key !== getAccountKey(connection.account) ||
        this.cache?.key !== this.#ownership.key)
    )
      throw new Error("Activate this account’s local data before connecting.");
    this.#connection = connection;
    const { playback, covers, tracks } = this.#options;
    playback.setConnection(connection?.queue);
    covers.setConnection(connection?.artwork);
    tracks.setPlaybackConnection(connection?.audio);
    tracks.setDownloadConnection(connection?.audio);
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

  /** Remembered identity is known before its asynchronously owned workspace opens. */
  get hasLocalAccount() {
    return !!(this.#account ?? this.#restoreAccount);
  }

  start(): Auth | null {
    if (this.#started || this.#destroyed) return this.auth;
    this.#started = true;
    const operationId = this.#beginOperation();
    try {
      this.downloadedOnly = this.#options.preferences.getItem("libras-downloaded-only") === "true";
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
      this.#restoreAccount = account;
      this.#restoration = this.#restore(account).catch((error) => this.#fail(error, operationId));
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
    if (!this.#isCurrentOperation(operationId) || !this.#ownership) return;
    if (!this.auth || this.offlineMode) {
      this.status = "disconnected";
      return;
    }
    this.#resumeOnline();
    await this.#refresh(false);
  }

  async #restore(account: Account) {
    const { covers, playback, selection } = this.#options;
    const key = getAccountKey(account);
    const release = await (this.#options.acquireOwnership ?? acquireAccountOwnership)(key);
    if (this.#destroyed) {
      await release();
      return;
    }
    this.#ownership = { key, release };
    this.ownershipIssue = undefined;
    const cache = new Cache(key);
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
      void this.#options.tracks.restoreDownloads();
      if (!canPublish()) return;
      await covers.refresh();
      if (canPublish()) this.localReady = true;
    } finally {
      if (this.#loadController === controller) this.#loadController = undefined;
    }
  }

  /** Load local data for verified credentials, without selecting the account.
   * Same-account reconnects reuse the live writer to retain queue edits. */
  async #prepareWorkspace(connection: NetworkConnection, cache: Cache) {
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
    await tracks.activate();
    signal.throwIfAborted();
    do {
      try {
        await previous.flush();
      } catch (error) {
        const unrelated = withoutDownloadErrors(error);
        if (unrelated !== undefined) throw unrelated;
        break;
      }
      signal.throwIfAborted();
    } while (previous.dirty);
  }

  /** No awaits: credentials, selection and engine connections commit in one turn.
   * Storage is not transactional; connect's failure path clears partial credentials. */
  #commitWorkspace(
    cache: Cache,
    credentials: Auth,
    connection: NetworkConnection,
    remember: boolean,
  ) {
    connection.signal.throwIfAborted();
    if (this.#ownership?.key !== getAccountKey(connection.account))
      throw new Error("Activate this account’s local data before connecting.");
    const { auth, preferences, network, playback } = this.#options;
    if (remember) auth.save(credentials);
    else auth.clear();
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

  /** Cancel authentication and candidate workspace work, retaining the offline account. */
  cancelConnect() {
    if (this.auth || this.#destroyed) return;
    this.#beginOperation();
    this.#authController?.abort();
    this.#authController = undefined;
    this.#options.network.cancelPending();
    this.status = "disconnected";
  }

  /** Authentication verifies; Session commits the workspace, then syncs in the background. */
  async connect(input: PasswordAuth, remember = false): Promise<boolean> {
    if (this.auth || this.busy || this.#destroyed || this.#deleting) return false;
    const operationId = this.#beginOperation();
    const controller = new AbortController();
    let candidate: { key: string; release: () => Promise<void> } | undefined;
    let candidateCache: Cache | undefined;
    this.#authController = controller;
    this.status = "connecting";
    try {
      await this.#restoration;
      const key = getAccountKey({ ...input, host: normalizeAndValidateServerHost(input.host) });
      if (this.#ownership?.key !== key) {
        const release = await (this.#options.acquireOwnership ?? acquireAccountOwnership)(key);
        candidate = { key, release };
      }
      controller.signal.throwIfAborted();
      if (!this.#isCurrentOperation(operationId)) return false;
      const verified = await authenticate(input, this.#options.network, controller.signal);
      if (!this.#isCurrentOperation(operationId)) return false;
      const { auth, connection } = verified;
      await this.#restoration;
      if (!this.#isCurrentOperation(operationId)) return false;
      connection.signal.throwIfAborted();
      const workspaceKey = getAccountKey(connection.account);
      const previous = this.cache;
      const cache = previous?.key === workspaceKey ? previous : new Cache(workspaceKey);
      candidateCache = cache;
      await this.#prepareWorkspace(connection, cache);
      connection.signal.throwIfAborted();
      if (!this.#isCurrentOperation(operationId)) return false;
      await this.#retireWorkspace(cache, connection.signal);
      if (!this.#isCurrentOperation(operationId)) return false;
      const previousCache = this.cache;
      const previousOwnership = this.#ownership;
      this.#ownership = candidate ?? previousOwnership;
      try {
        this.#commitWorkspace(cache, auth, connection, remember);
      } catch (error) {
        this.#ownership = previousOwnership;
        throw error;
      }
      if (candidate) {
        candidate = undefined;
        if (previousCache && previousCache !== cache) await previousCache.retire().catch(() => {});
        await previousOwnership?.release();
      }
      if (!this.#isCurrentOperation(operationId)) return false;
      this.ownershipIssue = undefined;
      this.status = "connected";
      this.loadingAfterConnect = true;
      void this.#refresh(false);
      return true;
    } catch (error) {
      if (this.#isCurrentOperation(operationId)) {
        // Also remove partially saved credentials if browser persistence failed.
        if (this.disconnect()) this.#fail(error, this.#operationId);
      }
      return false;
    } finally {
      if (candidate) {
        if (candidateCache && candidateCache !== this.cache)
          await candidateCache.retire().catch(() => {});
        await candidate.release();
      }
      if (this.#authController === controller) this.#authController = undefined;
      if (this.#isCurrentOperation(operationId) && this.status === "connecting")
        this.status = "disconnected";
    }
  }

  get blockedAccount() {
    return !this.#ownership && this.ownershipIssue ? this.#restoreAccount : undefined;
  }

  get cache() {
    return this.#options.selection.cache;
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

  get canResumeOnline() {
    const key = this.auth ? getAccountKey(this.auth) : undefined;
    return (
      !this.#destroyed &&
      key !== undefined &&
      this.#ownership?.key === key &&
      this.cache?.key === key
    );
  }

  #resumeOnline() {
    if (!this.auth || !this.canResumeOnline) return;
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
    const { covers } = this.#options;
    this.#syncState = force ? "manual" : "automatic";
    this.#libraryProgress = undefined;
    this.#refreshError = undefined;
    return (this.#refreshPending = (async () => {
      try {
        try {
          await this.#refreshLibrary(force, operationId);
        } finally {
          // Only the owning operation can reveal content after an explicit connect.
          // Artwork and playlists must not block the library.
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
    })().finally(() => {
      if (!this.#isCurrentOperation(operationId)) return;
      // Keep final scan counts until all sync work settles, then publish completion together.
      this.#libraryProgress = undefined;
      this.#syncState = "idle";
      this.#refreshPending = undefined;
    }));
  }

  async setOfflineMode(enabled: boolean) {
    if (!this.auth || !this.canResumeOnline) return;
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

  /** Leave a blocked startup for the connection form, without opening or deleting its data. */
  chooseAnotherAccount() {
    if (this.#ownership || this.busy) return;
    this.disconnect();
    this.ownershipIssue = undefined;
    this.#restoreAccount = undefined;
    this.localReady = true;
  }

  async retryOwnership() {
    if (this.busy || this.#destroyed || this.#ownership || !this.#restoreAccount) return;
    const operationId = this.#beginOperation();
    this.status = "connecting";
    this.#restoration = this.#restore(this.#restoreAccount).catch((error) =>
      this.#fail(error, operationId),
    );
    await this.#finishStartup(operationId);
    if (this.ownershipIssue === "blocked")
      this.error = "This account is still open in another tab.";
  }

  /** Stop producers before deletion; a failed deletion retains the active lease. */
  clearLocalData(): Promise<void> {
    if (this.#deleting) return this.#deleting;
    const cache = this.cache;
    if (!this.#ownership || !cache || this.#destroyed || this.busy) return Promise.resolve();
    if (!this.disconnect()) return Promise.reject(new Error(this.error));
    this.#options.playback.suspend();
    this.#options.covers.activate();
    return (this.#deleting = (async () => {
      await this.#options.tracks.activate();
      await cache.clear();
    })().finally(() => {
      this.#deleting = undefined;
    }));
  }

  async destroy() {
    this.#destroyed = true;
    this.#operationId++;
    this.#loadController?.abort();
    this.#loadController = undefined;
    this.#detach();
    this.#options.playback.suspend();
    this.#options.covers.destroy();
    await this.#options.tracks.activate();
    await this.#restoration;
    await this.#deleting?.catch(() => {});
    await this.cache?.retire().catch(() => {});
    await this.#ownership?.release();
    this.#ownership = undefined;
  }
}
