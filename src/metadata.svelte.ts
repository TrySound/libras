import type { Memory } from "./memory.svelte";
import type { Album, Track } from "./schema";
import type { MetadataSnapshot, Storage } from "./storage";
import type { MetadataConnection } from "./network.svelte";

type MetadataMemory = Pick<
  Memory,
  "artists" | "albums" | "tracks" | "artistAlbums" | "albumTracks"
>;

function entityMap<T extends { id: string }>(items: readonly T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`Duplicate metadata ID: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

function prepareMetadata(snapshot?: MetadataSnapshot) {
  const artists = entityMap(
    [...(snapshot?.artists ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const albums = entityMap(snapshot?.albums ?? []);
  const tracks = entityMap(snapshot?.tracks ?? []);
  const artistAlbums = new Map<string, Album[]>();
  const albumTracks = new Map<string, Track[]>();
  for (const album of albums.values()) {
    const group = artistAlbums.get(album.artistId) ?? [];
    group.push(album);
    artistAlbums.set(album.artistId, group);
  }
  for (const track of tracks.values()) {
    const group = albumTracks.get(track.albumId) ?? [];
    group.push(track);
    albumTracks.set(track.albumId, group);
  }
  for (const group of artistAlbums.values()) {
    group.sort(
      (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title),
    );
  }
  for (const group of albumTracks.values()) {
    group.sort(
      (a, b) =>
        (a.disc ?? 1) - (b.disc ?? 1) ||
        (a.number ?? Infinity) - (b.number ?? Infinity) ||
        a.title.localeCompare(b.title),
    );
  }
  return { artists, albums, tracks, artistAlbums, albumTracks };
}

export type MetadataStatus = "idle" | "loading" | "refreshing" | "ready" | "error";

export class MetadataEngine {
  #memory: MetadataMemory;
  #snapshotInfo = $state.raw<Pick<MetadataSnapshot, "lastModified" | "savedAt">>();

  constructor(memory: MetadataMemory) {
    this.#memory = memory;
  }
  #storage?: Pick<Storage, "account" | "metadata">;
  #connection?: MetadataConnection;
  #scope = "";
  #restored = false;
  #restoring?: Promise<void>;
  #generation = 0;
  #libraryController?: AbortController;

  #invalidate() {
    this.#libraryController?.abort();
    this.#libraryController = undefined;
    return ++this.#generation;
  }
  #destroyed = false;
  #status = $state<MetadataStatus>("idle");
  #error = $state.raw<unknown>();
  #warning = $state.raw<unknown>();

  get savedAt() {
    return this.#snapshotInfo?.savedAt;
  }

  get status() {
    return this.#status;
  }
  get error() {
    return this.#error;
  }
  get warning() {
    return this.#warning;
  }

  #publish(snapshot?: MetadataSnapshot) {
    const prepared = prepareMetadata(snapshot);
    this.#snapshotInfo = snapshot && {
      lastModified: snapshot.lastModified,
      savedAt: snapshot.savedAt,
    };
    // No awaits between related map assignments.
    this.#memory.artists = prepared.artists;
    this.#memory.albums = prepared.albums;
    this.#memory.tracks = prepared.tracks;
    this.#memory.artistAlbums = prepared.artistAlbums;
    this.#memory.albumTracks = prepared.albumTracks;
  }

  // Startup restoration needs only account identity, not an authenticated connection.
  restore(storage: Pick<Storage, "account" | "metadata">): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    const account = storage.account;
    const scope = `${account.host}\n${account.username}`;
    if (scope === this.#scope) {
      if (this.#restoring) return this.#restoring;
      if (this.#restored) return Promise.resolve();
    }
    const generation = this.#invalidate();
    this.#scope = scope;
    this.#storage = storage;
    this.#restored = false;
    if (
      this.#connection &&
      (this.#connection.account.host !== account.host ||
        this.#connection.account.username !== account.username)
    )
      this.#connection = undefined;
    this.#publish();
    this.#status = "loading";
    this.#error = undefined;
    this.#warning = undefined;
    return (this.#restoring = storage.metadata
      .read()
      .then((snapshot) => {
        if (generation !== this.#generation || this.#destroyed) return;
        this.#publish(snapshot ?? undefined);
        this.#status = snapshot ? "ready" : "idle";
      })
      .catch((error) => {
        if (generation !== this.#generation || this.#destroyed) return;
        this.#error = error;
        this.#status = "error";
      })
      .finally(() => {
        if (generation !== this.#generation || this.#destroyed) return;
        this.#restoring = undefined;
        this.#restored = true;
      }));
  }

  async #fetchLibrary(
    connection: MetadataConnection,
    valid: () => boolean,
    lastModified: number | null,
  ) {
    if (!valid()) throw new DOMException("Metadata request superseded.", "AbortError");
    const controller = new AbortController();
    this.#libraryController = controller;
    try {
      const library = await connection.readLibrary(controller.signal);
      if (!valid()) throw new DOMException("Metadata request superseded.", "AbortError");
      return {
        account: connection.account,
        lastModified,
        savedAt: Date.now(),
        ...library,
      };
    } finally {
      controller.abort();
      if (this.#libraryController === controller) this.#libraryController = undefined;
    }
  }

  async #refresh(force: boolean) {
    const connection = this.#connection;
    if (this.#destroyed) return;
    if (this.#restoring) await this.#restoring;
    if (connection !== this.#connection || this.#destroyed) return;
    if (!connection || connection.signal.aborted) {
      this.#status = this.#snapshotInfo ? "ready" : "error";
      if (!this.#snapshotInfo)
        this.#error = new Error("No library is available offline. Reconnect to download metadata.");
      return;
    }
    const storage = this.#storage;
    if (
      !this.#restored ||
      !storage ||
      this.#scope !== `${connection.account.host}\n${connection.account.username}`
    )
      throw new Error("Restore the connection's account before refreshing metadata.");
    const generation = this.#invalidate();
    this.#error = undefined;
    this.#warning = undefined;
    const existing = this.#snapshotInfo;
    const valid = () =>
      !this.#destroyed &&
      generation === this.#generation &&
      connection === this.#connection &&
      !connection.signal.aborted;
    this.#status = existing ? "refreshing" : "loading";
    try {
      const modified =
        (await connection.getModifiedAt(existing?.lastModified ?? undefined)) ??
        existing?.lastModified ??
        null;
      if (!valid()) return;
      if (!force && existing && modified !== null && modified === existing.lastModified) {
        this.#status = "ready";
        return;
      }
      const snapshot = await this.#fetchLibrary(connection, valid, modified);
      if (!valid()) return;
      const committed = await storage.metadata.save(snapshot, valid);
      if (!valid() || !committed) return;
      this.#publish(committed);
      this.#status = "ready";
    } catch (error) {
      if (!valid()) return;
      if (existing) {
        this.#status = "ready";
        this.#warning = error;
      } else {
        this.#status = "error";
        this.#error = error;
      }
    }
  }

  /** Validate a candidate without changing the selected library or its saved snapshot. */
  async prepareConnection(connection: MetadataConnection): Promise<MetadataSnapshot> {
    if (this.#restoring) await this.#restoring;
    connection.signal.throwIfAborted();
    if (this.#destroyed) throw new DOMException("Metadata stopped.", "AbortError");
    const generation = this.#invalidate();
    const valid = () =>
      !this.#destroyed && generation === this.#generation && !connection.signal.aborted;
    this.#status = this.#snapshotInfo ? "refreshing" : "loading";
    try {
      const modified = await connection.getModifiedAt();
      const snapshot = await this.#fetchLibrary(connection, valid, modified);
      if (!valid()) throw new DOMException("Connection superseded.", "AbortError");
      return snapshot;
    } finally {
      if (valid()) {
        this.#status = this.#snapshotInfo ? "ready" : "idle";
      }
    }
  }

  async saveConnection(
    snapshot: MetadataSnapshot,
    storage: Pick<Storage, "account" | "metadata">,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.#destroyed) throw new DOMException("Metadata stopped.", "AbortError");
    if (
      storage.account.host !== snapshot.account.host ||
      storage.account.username !== snapshot.account.username
    )
      throw new Error("Metadata storage belongs to a different account.");
    const generation = this.#invalidate();
    const valid = () => !this.#destroyed && generation === this.#generation && !signal.aborted;
    const committed = await storage.metadata.save(snapshot, valid);
    if (!valid() || !committed) throw new DOMException("Connection superseded.", "AbortError");
    return committed;
  }

  /** Publish only after Session has accepted a successfully prepared connection. */
  acceptConnection(snapshot: MetadataSnapshot, storage: Pick<Storage, "account" | "metadata">) {
    if (this.#destroyed) return;
    if (
      storage.account.host !== snapshot.account.host ||
      storage.account.username !== snapshot.account.username
    )
      throw new Error("Metadata storage belongs to a different account.");
    this.#invalidate();
    this.#storage = storage;
    this.#scope = `${snapshot.account.host}\n${snapshot.account.username}`;
    this.#restored = true;
    this.#publish(snapshot);
    this.#status = "ready";
    this.#error = undefined;
    this.#warning = undefined;
  }

  refresh() {
    return this.#refresh(true);
  }

  revalidate() {
    return this.#refresh(false);
  }

  setConnection(connection: MetadataConnection | undefined) {
    if ((connection && connection === this.#connection) || this.#destroyed) return;
    this.#connection = connection;
    if (!this.#restoring) {
      this.#invalidate();
      this.#status = this.#snapshotInfo ? "ready" : "idle";
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#invalidate();
  }
}
