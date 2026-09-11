import type { Cache, CacheSelection, Immutable } from "./cache.svelte";
import type { ArtworkConnection } from "./network.svelte";
import type { ImageRecord } from "./schema";

const referenceFields = {
  artists: "artistArtwork",
  albums: "albumArtwork",
  tracks: "trackArtwork",
} as const;
const emptyCandidates: readonly string[] = [];
type Entity = keyof typeof referenceFields;
interface CoverOptions {
  allowNetwork: boolean;
}
interface Cover {
  readonly source: string | undefined;
  readonly cache: () => void;
}
interface CoverEntry {
  entity: Entity;
  id: string;
  allowNetwork: boolean;
  cover: Cover;
  generation: number;
  selected?: string;
  source?: string;
  network: boolean;
}
interface InstalledImage {
  fileName: string;
  source: string;
}

/** Resource acquisition and browser URLs; Cache owns references, records and bytes. */
export class CoverEngine {
  #selection: CacheSelection;
  #connection?: ArtworkConnection;
  #scope = new AbortController();
  #destroyed = false;
  #covers = new Map<string, CoverEntry>();
  #downloads = new Map<string, AbortController>();
  #loads = new Map<string, Promise<InstalledImage | undefined>>();
  #objectUrls = new Map<string, InstalledImage>();
  #version = $state(0);
  #listeners = new Set<() => void>();

  constructor(selection: CacheSelection) {
    this.#selection = selection;
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #notify() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  /** Session selected another cache. Invalidate resources, not persisted data. */
  activate() {
    if (this.#destroyed) return;
    this.#scope.abort();
    this.#scope = new AbortController();
    this.#cancelDownloads();
    this.#loads.clear();
    for (const entry of this.#covers.values()) {
      entry.generation++;
      entry.source = undefined;
      entry.network = false;
    }
    this.#covers.clear();
    this.#releaseObjectUrls();
    this.#notify();
  }

  /** Re-resolve existing handles from Cache's derived references; no catalog writes. */
  async refresh() {
    if (this.#destroyed) return;
    const cache = this.#selection.cache;
    if (!cache) return;
    for (const [id, image] of this.#objectUrls)
      if (cache.images.get(id)?.fileName !== image.fileName) this.#discardUrl(id);
    await Promise.all([...this.#covers.values()].map((entry) => this.#resolve(entry, false)));
  }

  #discardUrl(id: string) {
    const image = this.#objectUrls.get(id);
    if (!image) return;
    this.#objectUrls.delete(id);
    for (const entry of this.#covers.values())
      if (entry.source === image.source) entry.source = undefined;
    URL.revokeObjectURL(image.source);
  }
  #installBlob(record: Immutable<ImageRecord>, blob: Blob): InstalledImage {
    const existing = this.#objectUrls.get(record.id);
    if (existing?.fileName === record.fileName) return existing;
    this.#discardUrl(record.id);
    const image = { fileName: record.fileName, source: URL.createObjectURL(blob) };
    this.#objectUrls.set(record.id, image);
    return image;
  }

  #install(cache: Cache, record: Immutable<ImageRecord>): Promise<InstalledImage | undefined> {
    const existing = this.#objectUrls.get(record.id);
    if (existing?.fileName === record.fileName) return Promise.resolve(existing);
    const loading = this.#loads.get(record.fileName);
    if (loading) return loading;
    const signal = this.#scope.signal;
    const valid = () => !this.#destroyed && !signal.aborted && cache === this.#selection.cache;
    const load: Promise<InstalledImage | undefined> = (async () => {
      const blob = await cache.readImage(record.id, signal);
      if (!valid()) return;
      const latest = cache.images.get(record.id);
      // Missing old bytes may have revealed a competing tab's replacement. Retry
      // that reference, rather than falling back to the network while offline.
      if (!blob && latest && latest.fileName !== record.fileName)
        return this.#install(cache, latest);
      if (!blob || latest?.fileName !== record.fileName) return;
      return this.#installBlob(record, blob);
    })().finally(() => {
      if (this.#loads.get(record.fileName) === load) this.#loads.delete(record.fileName);
    });
    this.#loads.set(record.fileName, load);
    return load;
  }

  #candidates(entry: Pick<CoverEntry, "entity" | "id">) {
    return this.#selection.cache?.[referenceFields[entry.entity]].get(entry.id) ?? emptyCandidates;
  }
  async #resolve(entry: CoverEntry, revalidate: boolean) {
    const request = ++entry.generation;
    const signal = this.#scope.signal;
    const cache = this.#selection.cache;
    const candidates = this.#candidates(entry);
    const valid = () =>
      !this.#destroyed &&
      !signal.aborted &&
      cache === this.#selection.cache &&
      request === entry.generation &&
      candidates === this.#candidates(entry);
    if (!cache) return;
    for (const id of candidates) {
      const record = cache.images.get(id);
      if (!record) continue;
      try {
        const image = await this.#install(cache, record);
        if (!valid()) return;
        if (!image || cache.images.get(id)?.fileName !== image.fileName) continue;
        entry.source = image.source;
        entry.selected = id;
        entry.network = false;
        this.#notify();
        if (revalidate && entry.allowNetwork) this.#cacheImage(id);
        return;
      } catch {
        if (!valid()) return;
      }
    }
    if (!valid()) return;
    entry.selected = candidates[0];
    const connection = this.#networkConnection();
    entry.network = !!(entry.selected && entry.allowNetwork && connection);
    entry.source = undefined;
    if (entry.network && connection && entry.selected) {
      try {
        entry.source = connection.url(entry.selected, 500);
      } catch {
        entry.network = false;
      }
    }
    this.#notify();
  }

  #networkConnection() {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    return connection &&
      !connection.signal.aborted &&
      cache?.account &&
      cache.account.host === connection.account.host &&
      cache.account.username === connection.account.username
      ? connection
      : undefined;
  }
  #cacheImage(id: string) {
    const connection = this.#networkConnection();
    const cache = this.#selection.cache;
    if (!connection || !cache || this.#destroyed || this.#downloads.has(id)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, connection.signal, this.#scope.signal]);
    const valid = () =>
      !this.#destroyed &&
      !signal.aborted &&
      cache === this.#selection.cache &&
      this.#networkConnection() === connection;
    this.#downloads.set(id, controller);
    void (async () => {
      const cached = cache.images.get(id);
      if (cached && !cached.etag && !cached.lastModified) return;
      const result = await connection.read(id, {
        size: 500,
        etag: cached?.etag,
        lastModified: cached?.lastModified,
      });
      if (!valid() || !result || cache.images.get(id)?.fileName !== cached?.fileName) return;
      const blob = await cache.saveImage(id, result, signal);
      if (!valid()) return;
      const record = cache.images.get(id);
      if (blob && record) this.#installBlob(record, blob);
      await this.refresh();
    })()
      .catch(() => {})
      .finally(() => {
        if (this.#downloads.get(id) === controller) this.#downloads.delete(id);
      });
  }

  // Acquisition is explicit. Reading a returned handle never schedules new I/O.
  #ensureCover(entity: Entity, id: string, options: CoverOptions): Cover {
    this.#version;
    const key = JSON.stringify([entity, id, options.allowNetwork]);
    const existing = this.#covers.get(key);
    if (existing) return existing.cover;
    const engine = this;
    const entry: CoverEntry = {
      entity,
      id,
      allowNetwork: options.allowNetwork,
      generation: 0,
      network: false,
      cover: {
        get source() {
          engine.#version;
          return entry.source;
        },
        cache() {
          if (entry.network && entry.selected && engine.#covers.get(key) === entry)
            engine.#cacheImage(entry.selected);
        },
      },
    };
    this.#covers.set(key, entry);
    void Promise.resolve().then(() => {
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

  setConnection(connection: ArtworkConnection | undefined) {
    if (connection === this.#connection || this.#destroyed) return;
    this.#cancelDownloads();
    this.#connection = connection;
    for (const entry of this.#covers.values()) {
      entry.generation++;
      if (entry.network) {
        entry.network = false;
        entry.source = undefined;
      }
      void this.#resolve(entry, !!connection);
    }
    this.#notify();
  }
  #cancelDownloads() {
    for (const controller of this.#downloads.values()) controller.abort();
    this.#downloads.clear();
  }
  #releaseObjectUrls() {
    for (const image of this.#objectUrls.values()) URL.revokeObjectURL(image.source);
    this.#objectUrls.clear();
  }
  destroy() {
    this.#listeners.clear();
    this.activate();
    this.#destroyed = true;
    this.#scope.abort();
  }
}
