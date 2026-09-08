import * as v from "valibot";
import { OpfsJsonStore, jsonFileName } from "./json-store";
import { createSubscriber } from "svelte/reactivity";
import { SubsonicClient } from "./subsonic-client";
import type { MetadataSnapshot, MetadataEngine } from "./metadata-engine";
import type { MetadataAccount } from "./schema";
import type { Immutable } from "./memory.svelte";

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
const imageSchema = v.strictObject({
  id: idSchema,
  fileName: v.pipe(v.string(), v.regex(/^[a-f0-9-]+\.image$/)),
  type: v.pipe(v.string(), v.regex(/^image\//)),
  size: v.pipe(v.number(), v.integer(), v.minValue(1)),
  cachedAt: timeSchema,
  etag: v.optional(v.string()),
  lastModified: v.optional(v.string()),
});
const catalogSchema = v.strictObject({
  account: v.strictObject({ host: idSchema, username: idSchema }),
  metadataSavedAt: v.nullable(timeSchema),
  artists: v.array(referenceSchema),
  albums: v.array(referenceSchema),
  tracks: v.array(referenceSchema),
  images: v.array(imageSchema),
});
type Catalog = v.InferOutput<typeof catalogSchema>;
type ImageRecord = v.InferOutput<typeof imageSchema>;
type Entity = "artists" | "albums" | "tracks" | "image";
interface CoverEntry {
  entity: Entity;
  id: string;
  allowNetwork: boolean;
  candidates: string[];
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
function references(snapshot: Immutable<MetadataSnapshot>) {
  const albums = new Map(snapshot.albums.map((album) => [album.id, album]));
  const artists = new Map(snapshot.artists.map((artist) => [artist.id, artist]));
  const tracksByAlbum = new Map<string, (typeof snapshot.tracks)[number][]>();
  const albumsByArtist = new Map<string, (typeof snapshot.albums)[number][]>();
  for (const album of snapshot.albums) {
    const items = albumsByArtist.get(album.artistId) ?? [];
    items.push(album);
    albumsByArtist.set(album.artistId, items);
  }
  for (const track of snapshot.tracks) {
    const items = tracksByAlbum.get(track.albumId) ?? [];
    items.push(track);
    tracksByAlbum.set(track.albumId, items);
  }
  for (const items of albumsByArtist.values())
    items.sort(
      (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title),
    );
  for (const items of tracksByAlbum.values())
    items.sort(
      (a, b) =>
        (a.disc ?? 1) - (b.disc ?? 1) ||
        (a.number ?? Infinity) - (b.number ?? Infinity) ||
        a.title.localeCompare(b.title),
    );
  const albumCandidates = new Map(
    snapshot.albums.map((album) => [
      album.id,
      candidates([
        album.artworkId,
        ...(tracksByAlbum.get(album.id) ?? []).map((track) => track.artworkId),
      ]),
    ]),
  );
  const artistCandidates = new Map(
    snapshot.artists.map((artist) => [
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
    snapshot.artists.map((artist) => [
      artist.id,
      albumsByArtist.get(artist.id)?.find((album) => album.artworkId)?.artworkId,
    ]),
  );
  return {
    metadataSavedAt: snapshot.savedAt,
    artists: [...artistCandidates].map(([id, candidates]) => ({ id, candidates })),
    albums: [...albumCandidates].map(([id, candidates]) => ({ id, candidates })),
    tracks: snapshot.tracks.map((track) => {
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
  #metadata: Pick<MetadataEngine, "snapshot">;
  #client?: SubsonicClient;

  constructor(metadata: Pick<MetadataEngine, "snapshot">) {
    this.#metadata = metadata;
  }
  #catalog?: Catalog;
  #scope = "";
  #ready: Promise<void> = Promise.resolve();
  #generation = 0;
  #destroyed = false;
  #reconcileKey = "";
  #reconciling: Promise<void> = Promise.resolve();
  #files = new Map<string, Promise<OpfsJsonStore<Catalog>>>();
  #images = new Map<string, ImageRecord>();
  #references = {
    artists: new Map<string, string[]>(),
    albums: new Map<string, string[]>(),
    tracks: new Map<string, string[]>(),
  };
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
    const valid = () => generation === this.#generation && !this.#destroyed;
    if (this.#client && scope(this.#client) !== this.#scope) this.#client = undefined;
    this.#releaseObjectUrls();
    this.#loads.clear();
    this.#reconcileKey = "";
    this.#catalog = emptyCatalog(account);
    this.#images.clear();
    this.#references = { artists: new Map(), albums: new Map(), tracks: new Map() };
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
    const snapshot = this.#metadata.snapshot;
    if (!snapshot || this.#destroyed) return;
    await this.restore(snapshot.account);
    if (this.#destroyed || this.#scope !== scope(snapshot.account)) return;
    const key = `${this.#scope}\n${snapshot.savedAt}`;
    if (this.#reconcileKey === key) return this.#reconciling;
    this.#reconcileKey = key;
    if (this.#catalog?.metadataSavedAt === snapshot.savedAt) {
      this.#reconciling = Promise.resolve();
      return;
    }
    const generation = this.#generation;
    const valid = () =>
      !this.#destroyed && generation === this.#generation && key === this.#reconcileKey;
    const refs = references(snapshot);
    return (this.#reconciling = (async () => {
      try {
        const catalog = await this.#commit(
          snapshot.account,
          (latest) =>
            (latest.metadataSavedAt ?? -1) > snapshot.savedAt ? latest : { ...latest, ...refs },
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
    const obsolete: string[] = [];
    const images = new Map(catalog.images.map((image) => [image.id, image]));
    for (const [id, url] of this.#objectUrls) {
      if (this.#images.get(id)?.fileName !== images.get(id)?.fileName) {
        obsolete.push(url);
        this.#objectUrls.delete(id);
      }
    }
    this.#catalog = catalog;
    this.#images = images;
    for (const entity of ["artists", "albums", "tracks"] as const) {
      this.#references[entity] = new Map(
        catalog[entity].map((reference) => [reference.id, reference.candidates]),
      );
    }
    if (downloaded) this.#objectUrls.set(downloaded.id, URL.createObjectURL(downloaded.blob));
    await Promise.all([...this.#covers.values()].map((entry) => this.#resolve(entry, false)));
    for (const url of obsolete) URL.revokeObjectURL(url);
    this.#notify();
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
        generation !== this.#generation ||
        this.#images.get(record.id)?.fileName !== record.fileName
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
      !this.#destroyed && generation === this.#generation && request === entry.generation;
    entry.candidates =
      entry.entity === "image" ? [entry.id] : (this.#references[entry.entity].get(entry.id) ?? []);
    for (const id of entry.candidates) {
      const record = this.#images.get(id);
      if (!record) continue;
      try {
        const source = await this.#install(record);
        if (!valid()) return;
        if (!source) continue;
        entry.source = source;
        entry.selected = id;
        entry.network = false;
        this.#notify();
        if (revalidate && entry.allowNetwork && this.#client) this.#cache(id);
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
        if (this.#images.get(id)?.fileName === record.fileName) {
          this.#images.delete(id);
          const account = this.#catalog!.account;
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
    entry.network = !!(entry.selected && entry.allowNetwork && this.#client);
    entry.source = entry.network ? this.#client!.getCoverArtUrl(entry.selected!, 500) : undefined;
    this.#notify();
  }

  #cache(id: string) {
    const client = this.#client;
    if (!client || this.#destroyed) return;
    const key = `${scope(client)}\n${id}`;
    if (this.#downloads.has(key)) return;
    const generation = this.#generation;
    const valid = () => generation === this.#generation && !this.#destroyed;
    this.#error = undefined;
    const task = this.#download(id, client, valid)
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

  async #download(id: string, client: SubsonicClient, valid: () => boolean) {
    const cached = this.#images.get(id);
    if (cached && !cached.etag && !cached.lastModified) return;
    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);
    const response = await fetch(client.getCoverArtUrl(id, 500), { headers });
    if (!valid() || (response.status === 304 && cached)) return;
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    const blob = await response.blob();
    const record = v.parse(imageSchema, {
      id,
      fileName: `${crypto.randomUUID()}.image`,
      type: response.headers.get("Content-Type")?.split(";")[0] ?? "image/jpeg",
      size: blob.size,
      cachedAt: Date.now(),
      etag: response.headers.get("ETag") ?? undefined,
      lastModified: response.headers.get("Last-Modified") ?? undefined,
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
        client,
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

  #getCover(entity: Entity, id: string, options: CoverOptions): Cover {
    this.#subscribe();
    const key = JSON.stringify([entity, id, options.allowNetwork]);
    const existing = this.#covers.get(key);
    if (existing) return existing.cover;
    const engine = this;
    const entry: CoverEntry = {
      entity,
      id,
      allowNetwork: options.allowNetwork,
      candidates: entity === "image" ? [id] : (this.#references[entity].get(id) ?? []),
      generation: 0,
      network: false,
      cover: {
        get source() {
          engine.#subscribe();
          return entry.source;
        },
        get artworkId() {
          engine.#subscribe();
          return entry.candidates.find((id) => engine.#images.has(id)) ?? entry.candidates[0];
        },
        get cached() {
          engine.#subscribe();
          return entry.candidates.some((id) => engine.#images.has(id));
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
  getArtistCover(id: string, options: CoverOptions) {
    return this.#getCover("artists", id, options);
  }
  getAlbumCover(id: string, options: CoverOptions) {
    return this.#getCover("albums", id, options);
  }
  getTrackCover(id: string, options: CoverOptions) {
    return this.#getCover("tracks", id, options);
  }
  getCover(artworkId: string, options: CoverOptions) {
    return this.#getCover("image", artworkId, options);
  }

  setClient(client: SubsonicClient) {
    if (client === this.#client || this.#destroyed) return;
    this.#client = client;
    void this.restore(client).then(() => {
      if (this.#client === client && !this.#destroyed) {
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
