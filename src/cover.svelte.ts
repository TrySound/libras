import { tick, untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import type { Cache, CacheSelection, Immutable } from "./cache.svelte";
import { artworkNoStore, type ArtworkConnection } from "./network.svelte";
import type { ImageMetadata, ImageRecord } from "./schema";

const referenceFields = {
  artists: "artistArtwork",
  albums: "albumArtwork",
  tracks: "trackArtwork",
} as const;
const emptyCandidates: readonly string[] = [];
type Entity = keyof typeof referenceFields;
interface Cover {
  readonly source: string | undefined;
  readonly load: () => void;
}
/** Load prominent artwork as soon as its container mounts. */
export function immediateCover(cover: Pick<Cover, "load">): Attachment {
  return () => cover.load();
}

/** Defer cached-file reads, decoding and network acquisition until near the viewport. */
export function lazyCover(cover: Pick<Cover, "load">): Attachment {
  return (node) => {
    if (typeof IntersectionObserver === "undefined") {
      cover.load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        cover.load();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  };
}

interface CoverEntry {
  entity: Entity;
  id: string;
  cover: Cover;
  generation: number;
  source?: string;
  demanded: boolean;
}
interface InstalledImage {
  source: string;
  metadata: ImageMetadata;
  // Set only when these exact bytes are persisted. Memory-only images survive disk changes.
  persistedFileName?: string;
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

  constructor(selection: CacheSelection) {
    this.#selection = selection;
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
    }
    this.#covers.clear();
    for (const image of this.#objectUrls.values()) URL.revokeObjectURL(image.source);
    this.#objectUrls.clear();
    this.#version++;
  }

  /** Re-resolve references and check freshness for demanded covers. */
  async refresh() {
    if (this.#destroyed) return;
    await Promise.all(
      [...this.#covers.values()].map((entry) => this.#resolve(entry, entry.demanded)),
    );
    const sources = new Set([...this.#covers.values()].map((entry) => entry.source));
    for (const [id, image] of this.#objectUrls) {
      if (this.#currentImage(id) || sources.has(image.source)) continue;
      this.#objectUrls.delete(id);
      URL.revokeObjectURL(image.source);
    }
  }

  #currentImage(id: string) {
    const image = this.#objectUrls.get(id);
    return image &&
      (!image.persistedFileName ||
        image.persistedFileName === this.#selection.cache?.images.get(id)?.fileName)
      ? image
      : undefined;
  }

  /** Decode before publication, keeping the previous URL live during replacement. */
  async #decode(blob: Blob, metadata: ImageMetadata, signal: AbortSignal): Promise<InstalledImage> {
    signal.throwIfAborted();
    const source = URL.createObjectURL(blob);
    let abort: (() => void) | undefined;
    try {
      if (typeof Image !== "undefined" && typeof Image.prototype.decode === "function") {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          abort = () => {
            image.src = "";
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          image.src = source;
          image.decode().then(resolve, reject);
        });
      }
      signal.throwIfAborted();
      return { source, metadata };
    } catch (error) {
      URL.revokeObjectURL(source);
      throw error;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  #replaceImage(id: string, image: InstalledImage) {
    const previous = this.#objectUrls.get(id);
    this.#objectUrls.set(id, image);
    if (!previous) return;
    for (const entry of this.#covers.values())
      if (entry.source === previous.source) entry.source = image.source;
    // Let Svelte switch mounted images before retiring the previous URL.
    void tick().then(() => URL.revokeObjectURL(previous.source));
  }

  #install(cache: Cache, record: Immutable<ImageRecord>): Promise<InstalledImage | undefined> {
    const previous = this.#objectUrls.get(record.id);
    if (previous?.persistedFileName === record.fileName) return Promise.resolve(previous);
    const loading = this.#loads.get(record.fileName);
    if (loading) return loading;
    const signal = this.#scope.signal;
    const valid = () => !this.#destroyed && !signal.aborted && cache === this.#selection.cache;
    const load: Promise<InstalledImage | undefined> = (async () => {
      const opened = await cache.readImage(record.id, signal);
      if (!valid() || !opened) return;
      const image = await this.#decode(opened.blob, opened.record, signal);
      if (
        !valid() ||
        cache.images.get(record.id)?.fileName !== opened.record.fileName ||
        this.#objectUrls.get(record.id) !== previous
      ) {
        URL.revokeObjectURL(image.source);
        return this.#currentImage(record.id);
      }
      image.persistedFileName = opened.record.fileName;
      this.#replaceImage(record.id, image);
      return image;
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
    // Refreshes, reconnects and shared image updates must not acquire offscreen artwork.
    if (!entry.demanded) return;
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
      try {
        const record = cache.images.get(id);
        const image =
          this.#currentImage(id) ?? (record ? await this.#install(cache, record) : undefined);
        if (!valid()) return;
        if (!image || image !== this.#currentImage(id)) continue;
        entry.source = image.source;
        if (revalidate) this.#cacheImage(id);
        return;
      } catch {
        if (!valid()) return;
      }
    }
    if (!valid()) return;
    entry.source = undefined;
    if (revalidate && candidates[0]) this.#cacheImage(candidates[0]);
  }

  /** Image changes only affect handles referencing that artwork, never the whole catalog. */
  #refreshImage(id: string) {
    return Promise.all(
      [...this.#covers.values()]
        .filter((entry) => this.#candidates(entry).includes(id))
        .map((entry) => this.#resolve(entry, false)),
    );
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
    const cached = cache.images.get(id);
    const installed = this.#currentImage(id);
    const policy = installed?.metadata ?? cached;
    if (policy?.freshUntil !== undefined && policy.freshUntil > Date.now()) return;
    // Legacy records without freshness or validators keep their cache-first behavior.
    if (policy && policy.freshUntil === undefined && !policy.etag && !policy.lastModified) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, connection.signal, this.#scope.signal]);
    const valid = () =>
      !this.#destroyed &&
      !signal.aborted &&
      cache === this.#selection.cache &&
      this.#networkConnection() === connection;
    this.#downloads.set(id, controller);
    void (async () => {
      const result = await connection.read(id, { ...policy, size: 500 });
      if (!valid() || cache.images.get(id)?.fileName !== cached?.fileName) return;
      const metadata: ImageMetadata = {
        cacheControl: result.cacheControl,
        expires: result.expires,
        freshUntil: result.freshUntil,
        etag: result.etag,
        lastModified: result.lastModified,
      };
      let memory = installed;
      if (result.notModified) {
        if (memory) memory.metadata = metadata;
      } else {
        memory = await this.#decode(
          new Blob([result.blob], { type: result.type }),
          metadata,
          signal,
        );
        if (!valid() || cache.images.get(id)?.fileName !== cached?.fileName) {
          URL.revokeObjectURL(memory.source);
          return;
        }
        this.#replaceImage(id, memory);
        await this.#refreshImage(id);
      }
      if (!valid()) return;
      if (artworkNoStore(metadata)) {
        if (memory) memory.persistedFileName = undefined;
        if (cached) await cache.evictImage(id, cached.fileName, signal);
      } else if (result.notModified) {
        if (cached) {
          await cache.updateImage(id, cached.fileName, metadata, signal);
          if (valid() && cache.images.get(id)?.fileName !== cached.fileName)
            await this.#refreshImage(id);
        }
      } else {
        const saved = await cache.saveImage(id, result, signal);
        if (!valid()) return;
        if (saved && cache.images.get(id)?.fileName === saved.record.fileName) {
          if (memory) memory.persistedFileName = saved.record.fileName;
        } else {
          // Another tab won persistence: adopt its bytes rather than marking ours as saved.
          const winner = cache.images.get(id);
          if (winner) {
            await this.#install(cache, winner);
            if (valid()) await this.#refreshImage(id);
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.#downloads.get(id) === controller) this.#downloads.delete(id);
      });
  }

  /** Creating or reading a handle never schedules I/O. load() gates all acquisition. */
  #ensureCover(entity: Entity, id: string): Cover {
    this.#version;
    const key = JSON.stringify([entity, id]);
    const existing = this.#covers.get(key);
    if (existing) return existing.cover;
    const engine = this;
    const entry: CoverEntry = $state({
      entity,
      id,
      generation: 0,
      demanded: false,
      cover: {
        get source() {
          return entry.source;
        },
        load() {
          untrack(() => {
            if (engine.#covers.get(key) !== entry || engine.#destroyed) return;
            entry.demanded = true;
            void engine.#resolve(entry, true);
          });
        },
      },
    });
    this.#covers.set(key, entry);
    return entry.cover;
  }
  ensureArtistCover(id: string) {
    return this.#ensureCover("artists", id);
  }
  ensureAlbumCover(id: string) {
    return this.#ensureCover("albums", id);
  }
  ensureTrackCover(id: string) {
    return this.#ensureCover("tracks", id);
  }

  /** Session owns network access; disconnected handles retain local artwork and demand. */
  setConnection(connection: ArtworkConnection | undefined) {
    if (connection === this.#connection || this.#destroyed) return;
    this.#cancelDownloads();
    this.#connection = connection;
    for (const entry of this.#covers.values())
      void this.#resolve(entry, !!connection && entry.demanded);
  }
  #cancelDownloads() {
    for (const controller of this.#downloads.values()) controller.abort();
    this.#downloads.clear();
  }
  destroy() {
    this.activate();
    this.#destroyed = true;
    this.#scope.abort();
  }
}
