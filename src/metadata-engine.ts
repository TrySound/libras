import type { Memory } from "./memory.svelte";
import type { Artist, Album, Track, MetadataAccount } from "./schema";
import { entityMap, parseSnapshot, type MetadataSnapshot, type Storage } from "./storage";
import { createSubscriber } from "svelte/reactivity";
import type { MetadataConnection, RemoteAlbum, RemoteArtist, RemoteTrack } from "./network.svelte";

type MetadataMemory = Pick<
  Memory,
  "artists" | "albums" | "tracks" | "artistAlbums" | "albumTracks"
>;

function normalizeLibrary(
  account: MetadataAccount,
  sourceArtists: readonly RemoteArtist[],
  sourceAlbums: readonly RemoteAlbum[],
  songs: ReadonlyMap<string, readonly RemoteTrack[]>,
  lastModified: number | null,
  savedAt: number,
): MetadataSnapshot {
  const artists = new Map<string, Artist>();
  const byName = new Map<string, Artist>();
  const syntheticId = (name: string) => `local:artist:${encodeURIComponent(name)}`;
  for (const source of sourceArtists) {
    const artist: Artist = {
      id: source.id || syntheticId(source.name),
      name: source.name,
      artworkId: source.artworkId,
      genres: source.genres,
    };
    if (artists.has(artist.id)) throw new Error(`Duplicate artist ID: ${artist.id}`);
    artists.set(artist.id, artist);
    byName.set(artist.name, artist);
  }
  const artistFor = (id?: string, name?: string, fallback?: Artist): Artist => {
    if (!id && !name && fallback) return fallback;
    const existing = id ? artists.get(id) : name ? byName.get(name) : undefined;
    if (existing) return existing;
    const resolvedName = name || "Unknown artist";
    const artist: Artist = { id: id || syntheticId(resolvedName), name: resolvedName, genres: [] };
    artists.set(artist.id, artist);
    byName.set(artist.name, artist);
    return artist;
  };
  const albums: Album[] = [];
  const tracks: Track[] = [];
  for (const source of sourceAlbums) {
    const owner = artistFor(source.artistId, source.artistName);
    albums.push({
      id: source.id,
      title: source.title,
      artistId: owner.id,
      artworkId: source.artworkId,
      year: source.year,
      genres: source.genres,
    });
    const albumTracks = songs.get(source.id);
    if (!albumTracks) throw new Error(`Missing tracks for album ${source.id}.`);
    for (const song of albumTracks) {
      if (song.albumId && song.albumId !== source.id)
        throw new Error(`Unexpected album for track ${song.id}.`);
      tracks.push({
        id: song.id,
        title: song.title,
        albumId: source.id,
        artistId: artistFor(song.artistId, song.artistName, owner).id,
        artworkId: song.artworkId,
        number: song.number,
        disc: song.disc,
        duration: song.duration,
        mimeType: song.mimeType,
        genres: song.genres,
      });
    }
  }
  return parseSnapshot({
    account: { host: account.host, username: account.username },
    lastModified,
    savedAt,
    artists: [...artists.values()],
    albums,
    tracks,
  });
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
  #snapshotInfo?: Pick<MetadataSnapshot, "lastModified" | "savedAt">;

  constructor(memory: MetadataMemory, storage: Pick<Storage, "metadata">) {
    this.#memory = memory;
    this.#storage = storage;
  }
  #storage: Pick<Storage, "metadata">;
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
  #status: MetadataStatus = "idle";
  #error: unknown;
  #warning: unknown;
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  get savedAt() {
    this.#subscribe();
    return this.#snapshotInfo?.savedAt;
  }

  get status() {
    this.#subscribe();
    return this.#status;
  }
  get error() {
    this.#subscribe();
    return this.#error;
  }
  get warning() {
    this.#subscribe();
    return this.#warning;
  }

  #publish(snapshot?: MetadataSnapshot) {
    const prepared = prepareMetadata(snapshot);
    this.#snapshotInfo = snapshot && {
      lastModified: snapshot.lastModified,
      savedAt: snapshot.savedAt,
    };
    // No awaits or subscriber notifications between related map assignments.
    this.#memory.artists = prepared.artists;
    this.#memory.albums = prepared.albums;
    this.#memory.tracks = prepared.tracks;
    this.#memory.artistAlbums = prepared.artistAlbums;
    this.#memory.albumTracks = prepared.albumTracks;
  }

  // Startup restoration needs only account identity, not an authenticated connection.
  restore(account: MetadataAccount): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    const scope = `${account.host}\n${account.username}`;
    if (scope === this.#scope) {
      if (this.#restoring) return this.#restoring;
      if (this.#restored) return Promise.resolve();
    }
    const generation = this.#invalidate();
    this.#scope = scope;
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
    this.#update();
    return (this.#restoring = this.#storage
      .metadata(account)
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
        this.#update();
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
      return normalizeLibrary(
        connection.account,
        library.artists,
        library.albums,
        library.tracksByAlbum,
        lastModified,
        Date.now(),
      );
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
      this.#update();
      return;
    }
    if (
      !this.#restored ||
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
    this.#update();
    try {
      const modified =
        (await connection.getModifiedAt(existing?.lastModified ?? undefined)) ??
        existing?.lastModified ??
        null;
      if (!valid()) return;
      if (!force && existing && modified !== null && modified === existing.lastModified) {
        this.#status = "ready";
        this.#update();
        return;
      }
      const snapshot = await this.#fetchLibrary(connection, valid, modified);
      if (!valid()) return;
      const committed = await this.#storage.metadata(snapshot.account).save(snapshot, valid);
      if (!valid() || !committed) return;
      this.#publish(committed);
      this.#status = "ready";
      this.#update();
    } catch (error) {
      if (!valid()) return;
      if (existing) {
        this.#status = "ready";
        this.#warning = error;
      } else {
        this.#status = "error";
        this.#error = error;
      }
      this.#update();
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
    this.#update();
    try {
      const modified = await connection.getModifiedAt();
      const snapshot = await this.#fetchLibrary(connection, valid, modified);
      if (!valid()) throw new DOMException("Connection superseded.", "AbortError");
      return snapshot;
    } finally {
      if (valid()) {
        this.#status = this.#snapshotInfo ? "ready" : "idle";
        this.#update();
      }
    }
  }

  async saveConnection(snapshot: MetadataSnapshot, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#destroyed) throw new DOMException("Metadata stopped.", "AbortError");
    const generation = this.#invalidate();
    const valid = () => !this.#destroyed && generation === this.#generation && !signal.aborted;
    const committed = await this.#storage.metadata(snapshot.account).save(snapshot, valid);
    if (!valid() || !committed) throw new DOMException("Connection superseded.", "AbortError");
    return committed;
  }

  /** Publish only after Session has accepted a successfully prepared connection. */
  acceptConnection(snapshot: MetadataSnapshot) {
    if (this.#destroyed) return;
    this.#invalidate();
    this.#scope = `${snapshot.account.host}\n${snapshot.account.username}`;
    this.#restored = true;
    this.#publish(snapshot);
    this.#status = "ready";
    this.#error = undefined;
    this.#warning = undefined;
    this.#update();
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
      this.#update();
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#invalidate();
  }
}
