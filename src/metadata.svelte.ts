import type { MetadataConnection } from "./network.svelte";
import type { Memory } from "./memory.svelte";
import type { Album, Track } from "./schema";
import type { MetadataSnapshot, Storage } from "./storage";

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
  #updateController?: AbortController;

  #invalidate() {
    this.#updateController?.abort();
    this.#updateController = undefined;
    return ++this.#generation;
  }
  #destroyed = false;
  #status = $state<MetadataStatus>("idle");
  #error = $state.raw<unknown>();

  get savedAt() {
    return this.#snapshotInfo?.savedAt;
  }

  get status() {
    return this.#status;
  }
  get error() {
    return this.#error;
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
    this.#publish();
    this.#status = "loading";
    this.#error = undefined;
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

  setConnection(connection: MetadataConnection | undefined) {
    if (this.#destroyed || connection === this.#connection) return;
    this.#connection = connection;
    // Attaching network access must not invalidate pending local restoration.
    if (!this.#restoring) {
      this.#invalidate();
      this.#status = this.#snapshotInfo ? "ready" : "idle";
    }
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
    const storage = this.#storage;
    if (
      !this.#restored ||
      !storage ||
      this.#scope !== `${connection.account.host}\n${connection.account.username}`
    )
      throw new Error("Restore the account before refreshing metadata.");
    const generation = this.#invalidate();
    const controller = new AbortController();
    this.#updateController = controller;
    const signal = AbortSignal.any([controller.signal, connection.signal]);
    const valid = () => !this.#destroyed && generation === this.#generation && !signal.aborted;
    const existing = this.#snapshotInfo;
    this.#error = undefined;
    this.#status = existing ? "refreshing" : "loading";
    try {
      const modified =
        (await connection.getModifiedAt(existing?.lastModified ?? undefined)) ??
        existing?.lastModified ??
        null;
      if (!valid()) return;
      if (!force && existing && modified !== null && modified === existing.lastModified) return;
      const library = await connection.readLibrary(signal);
      if (!valid()) return;
      const snapshot = {
        ...library,
        account: connection.account,
        lastModified: modified,
        savedAt: Date.now(),
      };
      const committed = await storage.metadata.save(snapshot, valid);
      if (committed && valid()) this.#publish(committed);
    } catch (error) {
      if (valid()) throw error;
    } finally {
      if (generation === this.#generation && !this.#destroyed)
        this.#status = this.#snapshotInfo ? "ready" : "idle";
      controller.abort();
      if (this.#updateController === controller) this.#updateController = undefined;
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
  }

  destroy() {
    this.#destroyed = true;
    this.#invalidate();
  }
}
