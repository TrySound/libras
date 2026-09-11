import type { Auth, AuthStore } from "./auth";
import type { CoverEngine } from "./cover.svelte";
import type { Memory, MemoryView } from "./memory.svelte";
import type { MetadataEngine } from "./metadata.svelte";
import {
  NetworkTransportError,
  type ActiveNetworkConnection,
  type Network,
  type PasswordAuth,
} from "./network.svelte";
import type { PlaybackEngine } from "./playback.svelte";
import type { QueueEngine } from "./queue.svelte";
import type { Account, ConnectionStatus } from "./schema";
import type { TrackEngine } from "./track.svelte";
import { Storage as AccountStorage } from "./storage";
import { Cache } from "./cache.svelte";

const offlineModeStorageKey = "navidrome-offline-mode";

interface SessionOptions {
  memory: MemoryView & Pick<Memory, "account" | "cache">;
  network: Network;
  auth: Pick<AuthStore, "load" | "save" | "clear" | "loadAccount" | "saveAccount">;
  metadata: Pick<MetadataEngine, "prepareConnection" | "setConnection" | "refresh">;
  covers: Pick<CoverEngine, "restore" | "refresh" | "setConnection">;
  queue: Pick<
    QueueEngine,
    "restore" | "refresh" | "flush" | "setConnection" | "error" | "storageError"
  >;
  tracks: Pick<TrackEngine, "restore" | "setConnection">;
  playback: Pick<PlaybackEngine, "suspend" | "suspendNetwork">;
  preferences: Pick<Storage, "getItem" | "setItem">;
}

function connectionError(error: unknown) {
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
  #syncing = $state(false);
  #refreshError = $state.raw<unknown>();
  #refreshPending?: Promise<void>;
  #restoration: Promise<void> = Promise.resolve();
  #loadController?: AbortController;
  #generation = 0;
  #workspaces = new Map<string, AccountStorage>();
  #started = false;
  #destroyed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  get syncing() {
    return this.#syncing;
  }

  get refreshError() {
    const error =
      this.#refreshError ?? this.#options.queue.error ?? this.#options.queue.storageError;
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

  #selectAccount(account: Account) {
    const current = this.#options.memory.account;
    if (current?.host === account.host && current.username === account.username) return current;
    return (this.#options.memory.account = Object.freeze({
      host: account.host,
      username: account.username,
    }));
  }

  #storageFor(account: Account) {
    const key = `${account.host}\n${account.username}`;
    let storage = this.#workspaces.get(key);
    if (!storage) {
      storage = new AccountStorage(account);
      this.#workspaces.set(key, storage);
    }
    return storage;
  }

  #begin() {
    this.error = "";
    return ++this.#generation;
  }

  #fail(error: unknown, generation: number) {
    if (!this.#valid(generation)) return;
    this.status = "error";
    this.error = connectionError(error);
  }

  #detach() {
    const { metadata, queue, covers, tracks, playback } = this.#options;
    this.#refreshPending = undefined;
    this.#syncing = false;
    this.#refreshError = undefined;
    metadata.setConnection(undefined);
    queue.setConnection(undefined);
    this.#options.network.setMode("offline");
    covers.setConnection(undefined);
    tracks.setConnection(undefined);
    playback.suspendNetwork();
    void queue.flush();
  }

  #attach(connection: ActiveNetworkConnection) {
    const { metadata, queue, covers, tracks } = this.#options;
    metadata.setConnection(connection.metadata);
    queue.setConnection(connection.queue);
    covers.setConnection(connection.artwork);
    tracks.setConnection(connection.audio);
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
    const { covers, queue, tracks, memory } = this.#options;
    this.localReady = false;
    const cache = new Cache(account);
    this.#selectAccount(cache.account);
    memory.cache = cache;
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;
    const current = () => !this.#destroyed && memory.cache === cache;
    const storage = this.#storageFor(cache.account);
    try {
      await Promise.all([
        cache.load(controller.signal).catch((error) => {
          if (current())
            this.error = `Could not restore library: ${error instanceof Error ? error.message : String(error)}`;
        }),
        covers.restore(storage),
        tracks.restore(storage),
      ]);
      if (!current()) return;
      // A corrupt library must not block the other local domains.
      await queue.restore(storage);
      if (current()) await covers.refresh();
      if (current()) this.localReady = true;
    } finally {
      if (this.#loadController === controller) this.#loadController = undefined;
    }
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
      const { metadata, queue, covers, tracks, auth, preferences } = this.#options;
      // Explicit connection may use the network while the offline switch is locked.
      // Do not replace the selected workspace, or attach any other engines, on failure.
      const prepared = await metadata.prepareConnection(connection.metadata);
      if (!this.#valid(generation)) return false;
      auth.save(credentials);
      auth.saveAccount(prepared.account);
      preferences.setItem(offlineModeStorageKey, "false");
      // Never prepare into the selected cache, including same-account reconnects.
      const cache = new Cache(prepared.account);
      const { account: _account, ...library } = prepared;
      await cache.replaceLibrary(library, connection.signal);
      if (!this.#valid(generation)) return false;
      const activeConnection = this.#options.network.accept(connection);
      this.#options.playback.suspend();
      this.#selectAccount(cache.account);
      this.localReady = false;
      // Cancel old metadata work before selecting the prepared cache. Resource
      // restoration clears foreign state synchronously, without an intervening await.
      metadata.setConnection(undefined);
      const storage = this.#storageFor(cache.account);
      this.#restoration = Promise.all([
        queue.restore(storage),
        covers.restore(storage),
        tracks.restore(storage),
      ]).then(() => {});
      this.#options.memory.cache = cache;
      this.auth = credentials;
      this.#attach(activeConnection);
      await this.#restoration;
      if (!this.#valid(generation)) return false;
      this.localReady = true;
      await covers.refresh();
      if (!this.#valid(generation)) return false;
      await queue.refresh();
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
      const account = this.#options.memory.account;
      if (account) this.#options.auth.saveAccount(account);
      return true;
    } catch (error) {
      this.#fail(error, generation);
      return false;
    }
  }

  #resumeOnline(generation: number) {
    if (!this.auth || !this.#valid(generation)) return;
    this.#attach(this.#options.network.open(this.auth));
    this.status = "connected";
  }

  async refresh() {
    if (!this.auth || this.offlineMode || this.busy || this.#destroyed) return;
    this.error = "";
    await this.#refresh(true);
  }

  #refresh(force: boolean): Promise<void> {
    if (this.#refreshPending) return this.#refreshPending;
    const generation = this.#generation;
    const { metadata, covers, queue } = this.#options;
    this.#syncing = true;
    this.#refreshError = undefined;
    return (this.#refreshPending = (async () => {
      try {
        await metadata.refresh(force);
        if (!this.#valid(generation)) return;
        this.error = "";
        await covers.refresh();
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
