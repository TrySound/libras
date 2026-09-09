import * as v from "valibot";
import { OpfsJsonStore, jsonFileName } from "./json-store";
import { createSubscriber } from "svelte/reactivity";
import type { ArtworkConnection } from "./network.svelte";
import { imageSchema, type ImageRecord, type MetadataAccount } from "./schema";
import type { Memory } from "./memory.svelte";

type CoverMemory = Pick<
  Memory,
  | "account"
  | "artists"
  | "albums"
  | "tracks"
  | "artistAlbums"
  | "albumTracks"
  | "images"
  | "artistArtwork"
  | "albumArtwork"
  | "trackArtwork"
>;

const referenceFields = {
  artists: "artistArtwork",
  albums: "albumArtwork",
  tracks: "trackArtwork",
} as const;

export interface CoverOptions {
  allowNetwork: boolean;
}
export interface Cover {
  readonly source: string | undefined;
  readonly artworkId: string | undefined;
  readonly cached: boolean;
  readonly cache: () => void;
}

const idSchema = v.pipe(v.string(), v.minLength(1));
const timeSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const referenceSchema = v.strictObject({ id: idSchema, candidates: v.array(idSchema) });
const catalogSchema = v.strictObject({
  account: v.strictObject({ host: idSchema, username: idSchema }),
  metadataSavedAt: v.nullable(timeSchema),
  artists: v.array(referenceSchema),
  albums: v.array(referenceSchema),
  tracks: v.array(referenceSchema),
  images: v.array(imageSchema),
});
type Catalog = v.InferOutput<typeof catalogSchema>;
type Entity = "artists" | "albums" | "tracks" | "image";
interface CoverEntry {
  entity: Entity;
  id: string;
  allowNetwork: boolean;
  candidates: readonly string[];
  cover: Cover;
  generation: number;
  selected?: string;
  source?: string;
  network: boolean;
}

function scope(account: MetadataAccount) {
  return `${account.host}\n${account.username}`;
}
function emptyCatalog(account: MetadataAccount): Catalog {
  return {
    account: { host: account.host, username: account.username },
    metadataSavedAt: null,
    artists: [],
    albums: [],
    tracks: [],
    images: [],
  };
}
function parseCatalog(value: unknown, account: MetadataAccount) {
  const catalog = v.parse(catalogSchema, value);
  if (scope(catalog.account) !== scope(account))
    throw new Error("The cover catalog belongs to a different account.");
  for (const records of [catalog.artists, catalog.albums, catalog.tracks, catalog.images]) {
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new Error("Duplicate IDs in the cover catalog.");
  }
  return catalog;
}
function candidates(values: readonly (string | undefined)[]) {
  return [...new Set(values.filter((id): id is string => Boolean(id)))];
}
function references(
  memory: Pick<CoverMemory, "artists" | "albums" | "tracks" | "artistAlbums" | "albumTracks">,
  savedAt: number,
) {
  const {
    albums,
    artists,
    tracks,
    albumTracks: tracksByAlbum,
    artistAlbums: albumsByArtist,
  } = memory;
  const albumCandidates = new Map(
    [...albums.values()].map((album) => [
      album.id,
      candidates([
        album.artworkId,
        ...(tracksByAlbum.get(album.id) ?? []).map((track) => track.artworkId),
      ]),
    ]),
  );
  const artistCandidates = new Map(
    [...artists.values()].map((artist) => [
      artist.id,
      candidates([
        artist.artworkId,
        ...(albumsByArtist.get(artist.id) ?? []).flatMap(
          (album) => albumCandidates.get(album.id) ?? [],
        ),
      ]),
    ]),
  );
  const artistAlbumArtwork = new Map(
    [...artists.values()].map((artist) => [
      artist.id,
      albumsByArtist.get(artist.id)?.find((album) => album.artworkId)?.artworkId,
    ]),
  );
  return {
    metadataSavedAt: savedAt,
    artists: [...artistCandidates].map(([id, candidates]) => ({ id, candidates })),
    albums: [...albumCandidates].map(([id, candidates]) => ({ id, candidates })),
    tracks: [...tracks.values()].map((track) => {
      const album = albums.get(track.albumId);
      const artist = album && artists.get(album.artistId);
      return {
        id: track.id,
        candidates: candidates([
          track.artworkId,
          album?.artworkId,
          artist?.artworkId,
          artist && artistAlbumArtwork.get(artist.id),
        ]),
      };
    }),
  };
}

export class CoverEngine {
  #memory: CoverMemory;
  #metadata: { readonly savedAt: number | undefined };
  #connection?: ArtworkConnection;

  constructor(memory: CoverMemory, metadata: { readonly savedAt: number | undefined }) {
    this.#memory = memory;
    this.#metadata = metadata;
  }
  #metadataSavedAt: number | null = null;
  #scope = "";
  #ready: Promise<void> = Promise.resolve();
  #generation = 0;
  #destroyed = false;
  #reconcileKey = "";
  #reconciling: Promise<void> = Promise.resolve();
  #files = new Map<string, Promise<OpfsJsonStore<Catalog>>>();
  #covers = new Map<string, CoverEntry>();
  #downloads = new Map<string, Promise<void>>();
  #loads = new Map<string, Promise<string | undefined>>();
  #objectUrls = new Map<string, string>();
  #error: unknown;
  #listeners = new Set<() => void>();
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #notify() {
    this.#update();
    for (const listener of this.#listeners) listener();
  }
  get error() {
    this.#subscribe();
    return this.#error;
  }
  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("images", { create: true });
  }
  #file({ host, username }: MetadataAccount) {
    const key = `${host}\n${username}`;
    let file = this.#files.get(key);
    if (!file) {
      file = jsonFileName(key)
        .then(
          (fileName) =>
            new OpfsJsonStore({
              directory: "images",
              fileName,
              lockName: `music-web-covers:${fileName}`,
              parse: (value) => parseCatalog(value, { host, username }),
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
  async #commit(
    account: MetadataAccount,
    change: (catalog: Catalog) => Catalog,
    valid: () => boolean,
  ) {
    const file = await this.#file(account);
    const result = await file.update((catalog) => change(catalog ?? emptyCatalog(account)), {
      valid,
    });
    return valid() ? (result.value ?? undefined) : undefined;
  }

  restore(account: MetadataAccount): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    if (this.#scope === scope(account)) return this.#ready;
    this.#scope = scope(account);
    const generation = ++this.#generation;
    const valid = () =>
      generation === this.#generation &&
      !this.#destroyed &&
      this.#memory.account !== null &&
      scope(this.#memory.account) === scope(account);
    if (this.#connection && scope(this.#connection.account) !== this.#scope)
      this.#connection = undefined;
    this.#releaseObjectUrls();
    this.#loads.clear();
    this.#reconcileKey = "";
    this.#memory.account = { host: account.host, username: account.username };
    this.#metadataSavedAt = null;
    this.#memory.images = new Map();
    this.#memory.artistArtwork = new Map();
    this.#memory.albumArtwork = new Map();
    this.#memory.trackArtwork = new Map();
    for (const entry of this.#covers.values()) {
      entry.source = undefined;
      entry.candidates = [];
      entry.generation++;
    }
    this.#covers.clear();
    this.#error = undefined;
    this.#notify();
    return (this.#ready = (async () => {
      try {
        let catalog = (await (await this.#file(account)).read()) ?? emptyCatalog(account);
        const directory = await this.#directory();
        const missing = new Set<string>();
        let next = 0;
        const worker = async () => {
          while (next < catalog.images.length && valid()) {
            const record = catalog.images[next++];
            try {
              const file = await (await directory.getFileHandle(record.fileName)).getFile();
              if (file.size !== record.size) missing.add(record.fileName);
            } catch (error) {
              if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
              missing.add(record.fileName);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, catalog.images.length) }, worker));
        if (!valid()) return;
        if (missing.size) {
          catalog = {
            ...catalog,
            images: catalog.images.filter((image) => !missing.has(image.fileName)),
          };
          try {
            catalog =
              (await this.#commit(
                account,
                (latest) => ({
                  ...latest,
                  images: latest.images.filter((image) => !missing.has(image.fileName)),
                }),
                valid,
              )) ?? catalog;
          } catch (error) {
            if (valid()) this.#error = error;
          }
        }
        if (valid()) await this.#apply(catalog);
      } catch (error) {
        if (valid()) {
          this.#error = error;
          this.#notify();
        }
      }
    })());
  }

  async refresh() {
    const account = this.#memory.account;
    const savedAt = this.#metadata.savedAt;
    if (!account || savedAt === undefined || this.#destroyed) return;
    // Capture immutable map references without rebuilding candidate lists on no-op refreshes.
    const { artists, albums, tracks, artistAlbums, albumTracks } = this.#memory;
    await this.restore(account);
    if (
      this.#destroyed ||
      this.#scope !== scope(account) ||
      this.#metadata.savedAt !== savedAt ||
      this.#memory.artists !== artists ||
      this.#memory.albums !== albums ||
      this.#memory.tracks !== tracks
    )
      return;
    const key = `${this.#scope}\n${savedAt}`;
    if (this.#reconcileKey === key) return this.#reconciling;
    this.#reconcileKey = key;
    if (this.#metadataSavedAt === savedAt) {
      this.#reconciling = Promise.resolve();
      return;
    }
    const generation = this.#generation;
    const valid = () =>
      !this.#destroyed &&
      generation === this.#generation &&
      key === this.#reconcileKey &&
      this.#metadata.savedAt === savedAt &&
      this.#memory.account !== null &&
      scope(this.#memory.account) === scope(account);
    const refs = references({ artists, albums, tracks, artistAlbums, albumTracks }, savedAt);
    return (this.#reconciling = (async () => {
      try {
        const catalog = await this.#commit(
          account,
          (latest) => ((latest.metadataSavedAt ?? -1) > savedAt ? latest : { ...latest, ...refs }),
          valid,
        );
        if (catalog && valid()) {
          this.#error = undefined;
          await this.#apply(catalog);
        }
      } catch (error) {
        if (!valid()) return;
        this.#reconcileKey = "";
        this.#error = error;
        this.#notify();
      }
    })());
  }

  async #apply(catalog: Catalog, downloaded?: { id: string; blob: Blob }) {
    if (
      this.#destroyed ||
      this.#scope !== scope(catalog.account) ||
      !this.#memory.account ||
      scope(this.#memory.account) !== this.#scope
    )
      return;
    const generation = this.#generation;
    const obsolete: string[] = [];
    const images = new Map(catalog.images.map((image) => [image.id, image]));
    for (const [id, url] of this.#objectUrls) {
      if (this.#memory.images.get(id)?.fileName !== images.get(id)?.fileName) {
        obsolete.push(url);
        this.#objectUrls.delete(id);
      }
    }
    const artistArtwork = new Map(
      catalog.artists.map((reference) => [reference.id, reference.candidates]),
    );
    const albumArtwork = new Map(
      catalog.albums.map((reference) => [reference.id, reference.candidates]),
    );
    const trackArtwork = new Map(
      catalog.tracks.map((reference) => [reference.id, reference.candidates]),
    );
    this.#metadataSavedAt = catalog.metadataSavedAt;
    this.#memory.images = images;
    this.#memory.artistArtwork = artistArtwork;
    this.#memory.albumArtwork = albumArtwork;
    this.#memory.trackArtwork = trackArtwork;
    if (downloaded) this.#objectUrls.set(downloaded.id, URL.createObjectURL(downloaded.blob));
    await Promise.all([...this.#covers.values()].map((entry) => this.#resolve(entry, false)));
    for (const url of obsolete) URL.revokeObjectURL(url);
    if (!this.#destroyed && generation === this.#generation) this.#notify();
  }

  #install(record: ImageRecord) {
    const existing = this.#objectUrls.get(record.id);
    if (existing) return Promise.resolve(existing);
    const loading = this.#loads.get(record.id);
    if (loading) return loading;
    const generation = this.#generation;
    const load = (async () => {
      const directory = await this.#directory();
      const file = await (await directory.getFileHandle(record.fileName)).getFile();
      if (file.size !== record.size)
        throw new DOMException("The cached image is incomplete.", "DataError");
      // Never hand mutable OPFS-backed files to the browser or Media Session.
      const bytes = await file.arrayBuffer();
      if (
        this.#destroyed ||
        generation !== this.#generation ||
        !this.#memory.account ||
        scope(this.#memory.account) !== this.#scope ||
        this.#memory.images.get(record.id)?.fileName !== record.fileName
      )
        return;
      const source = URL.createObjectURL(new Blob([bytes], { type: record.type }));
      this.#objectUrls.set(record.id, source);
      return source;
    })().finally(() => {
      if (this.#loads.get(record.id) === load) this.#loads.delete(record.id);
    });
    this.#loads.set(record.id, load);
    return load;
  }

  async #resolve(entry: CoverEntry, revalidate: boolean) {
    const request = ++entry.generation;
    const generation = this.#generation;
    const valid = () =>
      !this.#destroyed &&
      generation === this.#generation &&
      request === entry.generation &&
      this.#memory.account !== null &&
      scope(this.#memory.account) === this.#scope;
    entry.candidates =
      entry.entity === "image"
        ? [entry.id]
        : (this.#memory[referenceFields[entry.entity]].get(entry.id) ?? []);
    for (const id of entry.candidates) {
      const record = this.#memory.images.get(id);
      if (!record) continue;
      try {
        const source = await this.#install(record);
        if (!valid()) return;
        if (!source) continue;
        entry.source = source;
        entry.selected = id;
        entry.network = false;
        this.#notify();
        if (revalidate && entry.allowNetwork) this.#cache(id);
        return;
      } catch (error) {
        if (!valid()) return;
        if (
          !(error instanceof DOMException) ||
          (error.name !== "NotFoundError" && error.name !== "DataError")
        ) {
          this.#error = error;
          continue;
        }
        if (this.#memory.images.get(id)?.fileName === record.fileName) {
          const images = new Map(this.#memory.images);
          images.delete(id);
          this.#memory.images = images;
          const account = this.#memory.account!;
          void this.#commit(
            account,
            (catalog) => ({
              ...catalog,
              images: catalog.images.filter((image) => image.fileName !== record.fileName),
            }),
            () => generation === this.#generation && !this.#destroyed,
          ).catch((error) => {
            if (valid()) {
              this.#error = error;
              this.#notify();
            }
          });
        }
      }
    }
    if (!valid()) return;
    entry.selected = entry.candidates[0];
    const connection = this.#networkConnection();
    entry.network = !!(entry.selected && entry.allowNetwork && connection);
    entry.source = entry.network ? connection!.url(entry.selected!, 500) : undefined;
    this.#notify();
  }

  #networkConnection() {
    const connection = this.#connection;
    return connection &&
      !connection.signal.aborted &&
      this.#memory.account &&
      scope(connection.account) === this.#scope &&
      scope(this.#memory.account) === this.#scope
      ? connection
      : undefined;
  }

  #cache(id: string) {
    const connection = this.#networkConnection();
    if (!connection || this.#destroyed) return;
    const key = `${scope(connection.account)}\n${id}`;
    if (this.#downloads.has(key)) return;
    const generation = this.#generation;
    const valid = () =>
      generation === this.#generation &&
      !this.#destroyed &&
      this.#networkConnection() === connection;
    this.#error = undefined;
    const task = this.#download(id, connection, valid)
      .catch((error) => {
        if (valid()) {
          this.#error = error;
          this.#notify();
        }
      })
      .finally(() => {
        if (this.#downloads.get(key) === task) this.#downloads.delete(key);
      });
    this.#downloads.set(key, task);
  }

  async #download(id: string, connection: ArtworkConnection, valid: () => boolean) {
    const cached = this.#memory.images.get(id);
    if (cached && !cached.etag && !cached.lastModified) return;
    const result = await connection.read(id, {
      size: 500,
      etag: cached?.etag,
      lastModified: cached?.lastModified,
    });
    if (!valid() || !result) return;
    const { blob } = result;
    const record = v.parse(imageSchema, {
      id,
      fileName: `${crypto.randomUUID()}.image`,
      type: result.type,
      size: blob.size,
      cachedAt: Date.now(),
      etag: result.etag,
      lastModified: result.lastModified,
    });
    if (!valid()) return;
    const directory = await this.#directory();
    const handle = await directory.getFileHandle(record.fileName, { create: true });
    let writable: FileSystemWritableFileStream | undefined;
    let committed = false;
    try {
      writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      const catalog = await this.#commit(
        connection.account,
        (latest) => {
          const current = latest.images.find((image) => image.id === id);
          if (current && current.fileName !== cached?.fileName) return latest;
          return {
            ...latest,
            images: [...latest.images.filter((image) => image.id !== id), record],
          };
        },
        valid,
      );
      committed = catalog?.images.some((image) => image.fileName === record.fileName) ?? false;
      if (catalog && valid())
        await this.#apply(
          catalog,
          committed ? { id, blob: new Blob([blob], { type: record.type }) } : undefined,
        );
    } finally {
      if (!committed) {
        await writable?.abort().catch(() => {});
        await directory.removeEntry(record.fileName).catch(() => {});
      }
    }
  }

  // Explicit resource acquisition. Reading the returned handle does not schedule I/O.
  #ensureCover(entity: Entity, id: string, options: CoverOptions): Cover {
    this.#subscribe();
    const key = JSON.stringify([entity, id, options.allowNetwork]);
    const existing = this.#covers.get(key);
    if (existing) return existing.cover;
    const engine = this;
    const entry: CoverEntry = {
      entity,
      id,
      allowNetwork: options.allowNetwork,
      candidates: entity === "image" ? [id] : (this.#memory[referenceFields[entity]].get(id) ?? []),
      generation: 0,
      network: false,
      cover: {
        get source() {
          engine.#subscribe();
          return entry.source;
        },
        get artworkId() {
          engine.#subscribe();
          return (
            entry.candidates.find((id) => engine.#memory.images.has(id)) ?? entry.candidates[0]
          );
        },
        get cached() {
          engine.#subscribe();
          return entry.candidates.some((id) => engine.#memory.images.has(id));
        },
        cache() {
          if (entry.network && entry.selected && engine.#covers.get(key) === entry)
            engine.#cache(entry.selected);
        },
      },
    };
    this.#covers.set(key, entry);
    void this.#ready.then(() => {
      if (this.#covers.get(key) === entry && !this.#destroyed) return this.#resolve(entry, true);
    });
    return entry.cover;
  }
  ensureArtistCover(id: string, options: CoverOptions) {
    return this.#ensureCover("artists", id, options);
  }
  ensureAlbumCover(id: string, options: CoverOptions) {
    return this.#ensureCover("albums", id, options);
  }
  ensureTrackCover(id: string, options: CoverOptions) {
    return this.#ensureCover("tracks", id, options);
  }
  ensureCover(artworkId: string, options: CoverOptions) {
    return this.#ensureCover("image", artworkId, options);
  }

  setConnection(connection: ArtworkConnection | undefined) {
    if (connection === this.#connection || this.#destroyed) return;
    this.#connection = connection;
    if (!connection) {
      for (const entry of this.#covers.values()) {
        entry.generation++;
        if (entry.network) {
          entry.network = false;
          entry.source = undefined;
        }
        void this.#resolve(entry, false);
      }
      this.#notify();
      return;
    }
    void this.restore(connection.account).then(() => {
      if (this.#connection === connection && !this.#destroyed) {
        for (const entry of this.#covers.values()) void this.#resolve(entry, true);
      }
    });
  }
  #releaseObjectUrls() {
    for (const url of this.#objectUrls.values()) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }
  destroy() {
    this.#destroyed = true;
    this.#generation++;
    this.#covers.clear();
    this.#releaseObjectUrls();
    this.#listeners.clear();
  }
}
