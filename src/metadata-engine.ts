import * as v from "valibot";
import { createSubscriber } from "svelte/reactivity";
import {
  SubsonicClient,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicTrack,
} from "./subsonic-client";

const id = v.pipe(v.string(), v.minLength(1));
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const ordinal = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)));
const artistSchema = v.strictObject({
  id,
  name: v.string(),
  artworkId: v.optional(id),
  genres: v.array(v.string()),
});
const albumSchema = v.strictObject({
  id,
  title: v.string(),
  artistId: id,
  artworkId: v.optional(id),
  year: ordinal,
  genres: v.array(v.string()),
});
const trackSchema = v.strictObject({
  id,
  title: v.string(),
  albumId: id,
  artistId: id,
  artworkId: v.optional(id),
  number: ordinal,
  disc: ordinal,
  duration: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  mimeType: v.optional(v.string()),
  genres: v.array(v.string()),
});
const snapshotSchema = v.strictObject({
  account: v.strictObject({ host: id, username: id }),
  lastModified: v.nullable(timestamp),
  savedAt: timestamp,
  artists: v.array(artistSchema),
  albums: v.array(albumSchema),
  tracks: v.array(trackSchema),
});
export type Artist = v.InferOutput<typeof artistSchema>;
export type Album = v.InferOutput<typeof albumSchema>;
export type Track = v.InferOutput<typeof trackSchema>;
export type MetadataSnapshot = v.InferOutput<typeof snapshotSchema>;
export type MetadataAccount = MetadataSnapshot["account"];

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

class MetadataIndex {
  #artists = new Map<string, Artist>();
  #albums = new Map<string, Album>();
  #tracks = new Map<string, Track>();
  #artistAlbums = new Map<string, Album[]>();
  #albumTracks = new Map<string, Track[]>();
  #artistList: readonly Artist[] = [];
  constructor(snapshot?: MetadataSnapshot) {
    if (!snapshot) return;
    this.#artists = entityMap(snapshot.artists);
    this.#albums = entityMap(snapshot.albums);
    this.#tracks = entityMap(snapshot.tracks);
    this.#artistList = [...snapshot.artists].sort((a, b) => a.name.localeCompare(b.name));
    for (const album of snapshot.albums) {
      const group = this.#artistAlbums.get(album.artistId) ?? [];
      group.push(album);
      this.#artistAlbums.set(album.artistId, group);
    }
    for (const track of snapshot.tracks) {
      const group = this.#albumTracks.get(track.albumId) ?? [];
      group.push(track);
      this.#albumTracks.set(track.albumId, group);
    }
    for (const albums of this.#artistAlbums.values()) {
      albums.sort(
        (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title),
      );
    }
    for (const tracks of this.#albumTracks.values()) {
      tracks.sort(
        (a, b) =>
          (a.disc ?? 1) - (b.disc ?? 1) ||
          (a.number ?? Infinity) - (b.number ?? Infinity) ||
          a.title.localeCompare(b.title),
      );
    }
  }
  getArtists() {
    return this.#artistList;
  }
  getArtist(id: string) {
    return this.#artists.get(id);
  }
  getAlbum(id: string) {
    return this.#albums.get(id);
  }
  getTrack(id: string) {
    return this.#tracks.get(id);
  }
  getArtistAlbums(id: string): readonly Album[] {
    return this.#artistAlbums.get(id) ?? [];
  }
  getAlbumTracks(id: string): readonly Track[] {
    return this.#albumTracks.get(id) ?? [];
  }
}

class MetadataStore {
  #writes: Promise<unknown> = Promise.resolve();

  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("metadata", { create: true });
  }

  async #fileName(account: MetadataAccount) {
    const bytes = new TextEncoder().encode(`${account.host}\n${account.username}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
  }

  async load(account: MetadataAccount): Promise<MetadataSnapshot | null> {
    const directory = await this.#directory();
    try {
      const handle = await directory.getFileHandle(await this.#fileName(account));
      const snapshot = parseSnapshot(JSON.parse(await (await handle.getFile()).text()));
      if (
        snapshot.account.host !== account.host ||
        snapshot.account.username !== account.username
      ) {
        throw new Error("The metadata snapshot belongs to a different account.");
      }
      return snapshot;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  save(value: MetadataSnapshot, current: () => boolean = () => true) {
    const snapshot = parseSnapshot(value);
    const write = async () => {
      const existing = await this.load(snapshot.account).catch(() => null);
      if (!current()) return;
      if (
        existing &&
        ((existing.lastModified !== null &&
          snapshot.lastModified !== null &&
          existing.lastModified > snapshot.lastModified) ||
          (existing.lastModified === snapshot.lastModified && existing.savedAt > snapshot.savedAt))
      )
        return existing;
      const directory = await this.#directory();
      const name = await this.#fileName(snapshot.account);
      if (!current()) return;
      const handle = await directory.getFileHandle(name, { create: true });
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await handle.createWritable();
        await writable.write(JSON.stringify(snapshot));
        if (!current()) {
          await writable.abort();
          if ((await handle.getFile()).size === 0) await directory.removeEntry(name);
          return;
        }
        // OPFS commits the replacement on close, not on write.
        await writable.close();
        return snapshot;
      } catch (error) {
        await writable?.abort().catch(() => {});
        const file = await handle.getFile().catch(() => null);
        if (file?.size === 0) await directory.removeEntry(name).catch(() => {});
        throw error;
      }
    };
    const result = this.#writes.then(async () => {
      const name = await this.#fileName(snapshot.account);
      return navigator.locks
        ? navigator.locks.request(`music-web-metadata:${name}`, write)
        : write();
    });
    this.#writes = result.catch(() => {});
    return result;
  }
}

export type MetadataStatus = "idle" | "loading" | "refreshing" | "ready" | "error";
export type MetadataNetwork = "offline" | "online";

export class MetadataEngine {
  #index = new MetadataIndex();
  #snapshot?: MetadataSnapshot;
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

  get snapshot() {
    this.#subscribe();
    return this.#snapshot;
  }

  getArtists() {
    this.#subscribe();
    return this.#index.getArtists();
  }
  getArtist(id: string) {
    this.#subscribe();
    return this.#index.getArtist(id);
  }
  getAlbum(id: string) {
    this.#subscribe();
    return this.#index.getAlbum(id);
  }
  getTrack(id: string) {
    this.#subscribe();
    return this.#index.getTrack(id);
  }
  getArtistAlbums(id: string) {
    this.#subscribe();
    return this.#index.getArtistAlbums(id);
  }
  getAlbumTracks(id: string) {
    this.#subscribe();
    return this.#index.getAlbumTracks(id);
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
    const index = new MetadataIndex(snapshot);
    this.#snapshot = snapshot;
    this.#index = index;
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
      this.#status = this.#snapshot ? "ready" : "error";
      if (!this.#snapshot)
        this.#error = new Error("No library is available offline. Reconnect to download metadata.");
      this.#update();
      return;
    }
    const existing = this.#snapshot;
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
