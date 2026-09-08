import * as v from "valibot";
import type { Memory } from "./memory.svelte";
import {
  accountSchema,
  artistSchema,
  albumSchema,
  trackSchema,
  type Artist,
  type Album,
  type Track,
  type MetadataAccount,
} from "./schema";
import { OpfsJsonStore, jsonFileName } from "./json-store";
import { createSubscriber } from "svelte/reactivity";
import {
  SubsonicClient,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicTrack,
} from "./subsonic-client";

type MetadataMemory = Pick<
  Memory,
  "account" | "artists" | "albums" | "tracks" | "artistAlbums" | "albumTracks"
>;

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const snapshotSchema = v.strictObject({
  account: accountSchema,
  lastModified: v.nullable(timestamp),
  savedAt: timestamp,
  artists: v.array(artistSchema),
  albums: v.array(albumSchema),
  tracks: v.array(trackSchema),
});
export type MetadataSnapshot = v.InferOutput<typeof snapshotSchema>;

function entityMap<T extends { id: string }>(items: readonly T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`Duplicate metadata ID: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

function parseSnapshot(value: unknown): MetadataSnapshot {
  const snapshot = v.parse(snapshotSchema, value);
  const artists = entityMap(snapshot.artists);
  const albums = entityMap(snapshot.albums);
  entityMap(snapshot.tracks);
  for (const album of albums.values()) {
    if (!artists.has(album.artistId)) throw new Error(`Unknown artist for album ${album.id}.`);
  }
  for (const track of snapshot.tracks) {
    if (!artists.has(track.artistId) || !albums.has(track.albumId)) {
      throw new Error(`Invalid metadata references for track ${track.id}.`);
    }
  }
  return snapshot;
}

function genres(item: { genre?: string; genres?: { name: string }[] }) {
  const names = [item.genre ?? "", ...(item.genres ?? []).map((genre) => genre.name)]
    .flatMap((name) => name.split("|"))
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Map(names.map((name) => [name.toLocaleLowerCase(), name])).values()].sort((a, b) =>
    a.localeCompare(b),
  );
}

function normalizeLibrary(
  account: MetadataAccount,
  sourceArtists: readonly SubsonicArtist[],
  sourceAlbums: readonly SubsonicAlbum[],
  songs: ReadonlyMap<string, readonly SubsonicTrack[]>,
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
      artworkId: source.coverArt || undefined,
      genres: genres(source),
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
    const owner = artistFor(source.artistId, source.artist);
    albums.push({
      id: source.id,
      title: source.name,
      artistId: owner.id,
      artworkId: source.coverArt || undefined,
      year: source.year && source.year > 0 ? source.year : undefined,
      genres: genres(source),
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
        artistId: artistFor(song.artistId, song.artist, owner).id,
        artworkId: song.coverArt || undefined,
        number: song.track && song.track > 0 ? song.track : undefined,
        disc: song.discNumber && song.discNumber > 0 ? song.discNumber : undefined,
        duration: song.duration,
        mimeType: song.contentType,
        genres: genres(song),
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

class MetadataStore {
  #files = new Map<string, Promise<OpfsJsonStore<MetadataSnapshot>>>();

  #file({ host, username }: MetadataAccount) {
    const key = `${host}\n${username}`;
    let file = this.#files.get(key);
    if (!file) {
      file = jsonFileName(key)
        .then(
          (fileName) =>
            new OpfsJsonStore({
              directory: "metadata",
              fileName,
              lockName: `music-web-metadata:${fileName}`,
              parse: (value) => {
                const snapshot = parseSnapshot(value);
                if (snapshot.account.host !== host || snapshot.account.username !== username)
                  throw new Error("The metadata snapshot belongs to a different account.");
                return snapshot;
              },
            }),
        )
        .catch((error) => {
          this.#files.delete(key);
          throw error;
        });
      this.#files.set(key, file);
    }
    return file;
  }

  async load(account: MetadataAccount) {
    return (await this.#file(account)).read();
  }

  async save(snapshot: MetadataSnapshot, current: () => boolean = () => true) {
    const file = await this.#file(snapshot.account);
    const result = await file.update(
      (existing) => {
        if (
          existing &&
          ((existing.lastModified !== null &&
            snapshot.lastModified !== null &&
            existing.lastModified > snapshot.lastModified) ||
            (existing.lastModified === snapshot.lastModified &&
              existing.savedAt > snapshot.savedAt))
        )
          return undefined;
        return snapshot;
      },
      {
        valid: current,
        // Preserve metadata's existing policy: a fresh server snapshot may repair a bad cache.
        recoverReadError: () => null,
      },
    );
    return current() ? result.value : undefined;
  }
}

export type MetadataStatus = "idle" | "loading" | "refreshing" | "ready" | "error";
export type MetadataNetwork = "offline" | "online";

export class MetadataEngine {
  #memory: MetadataMemory;
  #snapshotInfo?: Pick<MetadataSnapshot, "lastModified" | "savedAt">;

  constructor(memory: MetadataMemory) {
    this.#memory = memory;
  }
  #store = new MetadataStore();
  #client?: SubsonicClient;
  #scope = "";
  #restored = false;
  #restoring?: Promise<void>;
  #generation = 0;
  #destroyed = false;
  #network: MetadataNetwork = "online";
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

  // Startup restoration needs only account identity, not an authenticated client.
  restore(account: MetadataAccount): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    const scope = `${account.host}\n${account.username}`;
    if (scope === this.#scope) {
      if (this.#restoring) return this.#restoring;
      if (this.#restored) return Promise.resolve();
    }
    const generation = ++this.#generation;
    this.#scope = scope;
    this.#restored = false;
    if (
      this.#client &&
      (this.#client.host !== account.host || this.#client.username !== account.username)
    )
      this.#client = undefined;
    this.#publish();
    this.#memory.account = { host: account.host, username: account.username };
    this.#status = "loading";
    this.#error = undefined;
    this.#warning = undefined;
    this.#update();
    return (this.#restoring = this.#store
      .load(account)
      .then((snapshot) => {
        if (generation !== this.#generation || this.#destroyed) return;
        this.#publish(snapshot ?? undefined);
        this.#status =
          this.#client && this.#network === "online"
            ? snapshot
              ? "refreshing"
              : "loading"
            : snapshot
              ? "ready"
              : "idle";
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

  async #fetchLibrary(client: SubsonicClient, valid: () => boolean, lastModified: number | null) {
    const check = () => {
      if (!valid()) throw new DOMException("Metadata request superseded.", "AbortError");
    };
    const fetchAlbums = async () => {
      const albums: SubsonicAlbum[] = [];
      for (let offset = 0; ; offset += 500) {
        check();
        const page = await client.getAlbumList2({
          type: "alphabeticalByArtist",
          size: 500,
          offset,
        });
        albums.push(...page);
        if (page.length < 500) return albums;
      }
    };
    const [artists, albums] = await Promise.all([client.getArtists(), fetchAlbums()]);
    check();
    const tracks = new Map<string, SubsonicTrack[]>();
    let next = 0;
    const worker = async () => {
      while (next < albums.length) {
        check();
        const album = albums[next++];
        tracks.set(album.id, await client.getAlbum(album.id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, albums.length) }, worker));
    check();
    return normalizeLibrary(
      { host: client.host, username: client.username },
      artists,
      albums,
      tracks,
      lastModified,
      Date.now(),
    );
  }

  async #refresh(force: boolean) {
    const client = this.#client;
    if (!client || this.#destroyed) return;
    const generation = ++this.#generation;
    this.#error = undefined;
    this.#warning = undefined;
    if (this.#network === "offline") {
      this.#status = this.#snapshotInfo ? "ready" : "error";
      if (!this.#snapshotInfo)
        this.#error = new Error("No library is available offline. Reconnect to download metadata.");
      this.#update();
      return;
    }
    const existing = this.#snapshotInfo;
    const valid = () =>
      !this.#destroyed && generation === this.#generation && client === this.#client;
    this.#status = existing ? "refreshing" : "loading";
    this.#update();
    try {
      const modified =
        (await client.getIndexes(existing?.lastModified ?? undefined)) ??
        existing?.lastModified ??
        null;
      if (!valid()) return;
      if (!force && existing && modified !== null && modified === existing.lastModified) {
        this.#status = "ready";
        this.#update();
        return;
      }
      const snapshot = await this.#fetchLibrary(client, valid, modified);
      if (!valid()) return;
      const committed = await this.#store.save(snapshot, valid);
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

  async refresh() {
    const client = this.#client;
    if (!client) return;
    if (this.#restoring) await this.#restoring;
    if (this.#client === client) return this.#refresh(true);
  }

  async setClient(client: SubsonicClient) {
    if (client === this.#client || this.#destroyed) return;
    this.#client = client;
    if (!this.#restored || this.#scope !== `${client.host}\n${client.username}`) {
      await this.restore(client);
    }
    if (this.#client === client) return this.#refresh(false);
  }

  async setNetwork(network: MetadataNetwork) {
    if (network === this.#network || this.#destroyed) return;
    this.#network = network;
    if (!this.#restoring) return this.#refresh(false);
  }

  destroy() {
    this.#destroyed = true;
    this.#generation++;
  }
}
