import type { AuthStore, PasswordAuth } from "./auth";
import type { CoverEngine } from "./cover-engine";
import type { MemoryView } from "./memory.svelte";
import type { MetadataEngine } from "./metadata-engine";
import type { PlaybackEngine } from "./playback-engine";
import type { QueueEngine } from "./queue-engine";
import type { ConnectionStatus } from "./schema";
import { SubsonicClient, type SubsonicAuth } from "./subsonic-client";
import type { TrackEngine } from "./track-engine";

const offlineModeStorageKey = "navidrome-offline-mode";

interface SessionOptions {
  memory: MemoryView;
  auth: Pick<AuthStore, "create" | "load" | "save" | "clear">;
  metadata: Pick<
    MetadataEngine,
    | "restore"
    | "refresh"
    | "revalidate"
    | "setClient"
    | "setNetwork"
    | "savedAt"
    | "status"
    | "error"
    | "warning"
  >;
  covers: Pick<CoverEngine, "restore" | "refresh" | "setClient">;
  queue: Pick<QueueEngine, "restore" | "setClient" | "setNetwork" | "synchronize" | "flush">;
  tracks: Pick<TrackEngine, "ready" | "getStatus" | "setClient">;
  playback: Pick<PlaybackEngine, "pause">;
  storage: Pick<Storage, "getItem" | "setItem">;
}

function connectionError(error: unknown) {
  if (error instanceof TypeError)
    return "Could not reach the server. Check the host and its CORS settings.";
  return error instanceof Error ? error.message : "Could not load artists.";
}

export class Session {
  auth = $state.raw<SubsonicAuth | null>(null);
  offlineMode = $state(false);
  status = $state<ConnectionStatus>("disconnected");
  error = $state("");
  refreshError = $state("");

  #options: SessionOptions;
  #client = $state.raw<SubsonicClient>();
  #generation = 0;
  #started = false;
  #destroyed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  get client() {
    return this.#client;
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

  #setNetwork() {
    const network = this.offlineMode ? "offline" : "online";
    this.#options.metadata.setNetwork(network);
    this.#options.queue.setNetwork(network);
  }

  start(): SubsonicAuth | null {
    if (this.#started || this.#destroyed) return this.auth;
    this.#started = true;
    const generation = this.#begin();
    this.offlineMode = this.#options.storage.getItem(offlineModeStorageKey) === "true";
    this.#setNetwork();
    try {
      this.auth = this.#options.auth.load();
    } catch {
      this.#options.auth.clear();
      return null;
    }
    if (this.auth) void this.#open(this.auth, generation);
    return this.auth;
  }

  async connect(input: PasswordAuth): Promise<boolean> {
    if (this.#destroyed) return false;
    const generation = this.#begin();
    try {
      const accepted = await this.#open(this.#options.auth.create(input), generation);
      return this.#valid(generation) && accepted;
    } catch (error) {
      this.#fail(error, generation);
      return false;
    }
  }

  #attach(auth: SubsonicAuth, client: SubsonicClient) {
    this.auth = auth;
    this.#client = client;
    this.#options.covers.setClient(client);
    this.#options.queue.setClient(client);
    this.#options.tracks.setClient(client);
    void this.#options.queue.synchronize();
  }

  async #open(auth: SubsonicAuth, generation: number): Promise<boolean> {
    const { metadata, covers, queue } = this.#options;
    const account = { host: auth.host, username: auth.username };
    const client = new SubsonicClient(auth);
    this.status = "connecting";
    try {
      if (
        this.#client &&
        (this.#client.host !== auth.host || this.#client.username !== auth.username)
      )
        this.#client = undefined;
      metadata.setClient(client);
      await Promise.all([metadata.restore(account), covers.restore(account)]);
      if (!this.#valid(generation)) return false;
      const cached = metadata.savedAt !== undefined;
      if (cached) {
        await covers.refresh();
        if (!this.#valid(generation)) return false;
        await queue.restore(account);
        if (!this.#valid(generation)) return false;
        this.#attach(auth, client);
      }
      await metadata.revalidate();
      if (!this.#valid(generation)) return false;
      if (metadata.status === "error") {
        this.#fail(metadata.error, generation);
        return false;
      }
      if (!cached) {
        await queue.restore(account);
        if (!this.#valid(generation)) return false;
        this.#attach(auth, client);
      }
      // Reconcile references after revalidation may have replaced metadata.
      await covers.refresh();
      if (!this.#valid(generation)) return false;
      if (this.offlineMode) await this.#applyOfflineLibrary(generation);
      return this.#report(generation, auth);
    } catch (error) {
      this.#fail(error, generation);
      return false;
    }
  }

  #report(generation: number, credentials?: SubsonicAuth) {
    if (!this.#valid(generation)) return false;
    const { metadata, auth } = this.#options;
    if (metadata.status === "error") {
      this.#fail(metadata.error, generation);
      return false;
    }
    if (metadata.warning) {
      this.status = "error";
      this.refreshError = `Background refresh failed: ${connectionError(metadata.warning)}`;
    } else if (this.offlineMode) {
      this.status = "disconnected";
    } else {
      if (credentials) auth.save(credentials);
      this.status = "connected";
    }
    return true;
  }

  async refresh() {
    if (!this.#client || this.#destroyed) return;
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

  async #applyOfflineLibrary(generation: number) {
    const { tracks, memory, playback } = this.#options;
    await tracks.ready();
    if (!this.#valid(generation) || !this.offlineMode) return;
    const current = memory.queueTracks[memory.queueIndex];
    if (current && tracks.getStatus(current) !== "downloaded") playback.pause();
  }

  async setOfflineMode(enabled: boolean) {
    if (this.#destroyed || enabled === this.offlineMode) return;
    const generation = this.#begin();
    this.offlineMode = enabled;
    const { storage, metadata, queue, covers } = this.#options;
    try {
      storage.setItem(offlineModeStorageKey, String(enabled));
      this.#setNetwork();
      if (enabled) {
        // Persist locally without waiting for an obsolete server save to settle.
        void queue.flush();
        await this.#applyOfflineLibrary(generation);
        if (this.#valid(generation)) this.status = "disconnected";
      } else if (this.#client) {
        this.status = "connecting";
        void queue.synchronize();
        await metadata.revalidate();
        if (!this.#valid(generation)) return;
        await covers.refresh();
        this.#report(generation);
      } else if (this.auth) {
        // Startup may have found credentials but no offline metadata.
        await this.#open(this.auth, generation);
      }
    } catch (error) {
      this.#fail(error, generation);
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#generation++;
  }
}
