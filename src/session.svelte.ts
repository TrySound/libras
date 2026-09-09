import type { Auth, AuthStore, PasswordAuth } from "./auth";
import type { CoverEngine } from "./cover-engine";
import type { MemoryView } from "./memory.svelte";
import type { MetadataEngine } from "./metadata-engine";
import type { Network, NetworkConnection } from "./network.svelte";
import type { PlaybackEngine } from "./playback-engine";
import type { QueueEngine } from "./queue-engine";
import type { ConnectionStatus, MetadataAccount } from "./schema";
import type { TrackEngine } from "./track-engine";

const offlineModeStorageKey = "navidrome-offline-mode";

interface SessionOptions {
  memory: MemoryView;
  network: Network;
  auth: Pick<AuthStore, "create" | "load" | "save" | "clear" | "loadAccount" | "saveAccount">;
  metadata: Pick<
    MetadataEngine,
    | "restore"
    | "refresh"
    | "revalidate"
    | "prepareConnection"
    | "saveConnection"
    | "acceptConnection"
    | "setConnection"
    | "savedAt"
    | "status"
    | "error"
    | "warning"
  >;
  covers: Pick<CoverEngine, "restore" | "refresh" | "setConnection">;
  queue: Pick<QueueEngine, "restore" | "setConnection" | "synchronize" | "flush">;
  tracks: Pick<TrackEngine, "setConnection">;
  playback: Pick<PlaybackEngine, "suspend" | "suspendNetwork">;
  storage: Pick<Storage, "getItem" | "setItem">;
}

function connectionError(error: unknown) {
  if (error instanceof TypeError)
    return "Could not reach the server. Check the host and its CORS settings.";
  return error instanceof Error ? error.message : "Could not connect to the server.";
}

export class Session {
  auth = $state.raw<Auth | null>(null);
  status = $state<ConnectionStatus>("disconnected");
  error = $state("");
  refreshError = $state("");

  #options: SessionOptions;
  #restoration: Promise<void> = Promise.resolve();
  #generation = 0;
  #started = false;
  #destroyed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
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
    this.refreshError = "";
    return ++this.#generation;
  }

  #fail(error: unknown, generation: number) {
    if (!this.#valid(generation)) return;
    this.status = "error";
    this.error = connectionError(error);
  }

  #detach() {
    const { metadata, queue, covers, tracks, playback } = this.#options;
    this.#options.network.setMode("offline");
    metadata.setConnection(undefined);
    queue.setConnection(undefined);
    covers.setConnection(undefined);
    tracks.setConnection(undefined);
    playback.suspendNetwork();
    void queue.flush();
  }

  #attach(connection: NetworkConnection) {
    const { metadata, queue, covers, tracks } = this.#options;
    metadata.setConnection(this.#options.network.metadata(connection));
    queue.setConnection(this.#options.network.queue(connection));
    covers.setConnection(this.#options.network.artwork(connection));
    tracks.setConnection(this.#options.network.audio(connection));
    void queue.synchronize();
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
        !this.auth || this.#options.storage.getItem(offlineModeStorageKey) === "true";
      this.#detach();
      this.#options.network.setMode(offlineMode ? "offline" : "online");
      if (this.offlineMode) this.#options.storage.setItem(offlineModeStorageKey, "true");
      if (account) {
        // Migrate existing installations before credentials can be removed.
        this.#options.auth.saveAccount(account);
        this.#restoration = this.#restore(account);
        if (this.auth) this.status = "connecting";
        void this.#restoration
          .then(async () => {
            if (!this.#valid(generation)) return;
            if (this.auth && !this.offlineMode) await this.#resumeOnline(generation);
            else this.status = "disconnected";
          })
          .catch((error) => this.#fail(error, generation));
      }
    } catch (error) {
      this.#fail(error, generation);
    }
    return this.auth;
  }

  async #restore(account: MetadataAccount) {
    const { metadata, covers, queue } = this.#options;
    await Promise.all([metadata.restore(account), covers.restore(account)]);
    if (this.#destroyed) return;
    // Queue restoration is credential-free even if the metadata cache is missing.
    await queue.restore(account);
    if (!this.#destroyed) await covers.refresh();
  }

  async connect(input: PasswordAuth): Promise<boolean> {
    if (this.auth || this.busy || this.#destroyed) return false;
    const generation = this.#begin();
    this.status = "connecting";
    try {
      const credentials = this.#options.auth.create(input);
      const connection = this.#options.network.prepare(credentials);
      await this.#restoration;
      if (!this.#valid(generation)) return false;
      const { metadata, queue, covers, auth, storage } = this.#options;
      // Explicit connection may use the network while the offline switch is locked.
      // Do not replace the selected workspace, or attach any other engines, on failure.
      const prepared = await metadata.prepareConnection(this.#options.network.metadata(connection));
      if (!this.#valid(generation)) return false;
      auth.save(credentials);
      auth.saveAccount(prepared.account);
      storage.setItem(offlineModeStorageKey, "false");
      const snapshot = await metadata.saveConnection(prepared, connection.signal);
      if (!this.#valid(generation)) return false;
      this.#options.network.accept(connection);
      this.#options.playback.suspend();
      // Clear foreign queue/artwork synchronously before publishing new metadata.
      this.#restoration = Promise.all([
        queue.restore(snapshot.account),
        covers.restore(snapshot.account),
      ]).then(() => {});
      metadata.acceptConnection(snapshot);
      this.auth = credentials;
      this.#attach(connection);
      await this.#restoration;
      if (!this.#valid(generation)) return false;
      await covers.refresh();
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
      this.#options.storage.setItem(offlineModeStorageKey, "true");
      const account = this.#options.memory.account;
      if (account) this.#options.auth.saveAccount(account);
      return true;
    } catch (error) {
      this.#fail(error, generation);
      return false;
    }
  }

  #report(generation: number) {
    if (!this.#valid(generation)) return;
    const { metadata } = this.#options;
    if (metadata.status === "error") this.#fail(metadata.error, generation);
    else if (metadata.warning) {
      this.status = "error";
      this.refreshError = `Background refresh failed: ${connectionError(metadata.warning)}`;
    } else this.status = "connected";
  }

  async #resumeOnline(generation: number) {
    if (!this.auth || !this.#valid(generation)) return;
    this.status = "connecting";
    this.#attach(this.#options.network.open(this.auth));
    await this.#options.metadata.revalidate();
    if (!this.#valid(generation)) return;
    await this.#options.covers.refresh();
    this.#report(generation);
  }

  async refresh() {
    if (!this.auth || this.offlineMode || this.busy || this.#destroyed) return;
    const generation = this.#begin();
    this.status = "connecting";
    try {
      await this.#options.metadata.refresh();
      if (!this.#valid(generation)) return;
      await this.#options.covers.refresh();
      this.#report(generation);
    } catch (error) {
      this.#fail(error, generation);
    }
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
      this.#options.storage.setItem(offlineModeStorageKey, String(enabled));
      if (!enabled) {
        await this.#restoration;
        if (this.#valid(generation)) await this.#resumeOnline(generation);
      }
    } catch (error) {
      this.#fail(error, generation);
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#generation++;
    this.#detach();
  }
}
