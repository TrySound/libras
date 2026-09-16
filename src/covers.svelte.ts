import { tick, untrack } from "svelte";
import { getAccountKey } from "./auth";
import type { Cache, CacheSelection, Immutable } from "./cache.svelte";
import { artworkNoStore, type ArtworkConnection } from "./network.svelte";
import type { ImageMetadata, ImageRecord } from "./schema";

interface Cover {
  readonly source: string | undefined;
  readonly load: () => void;
}
const emptyCover: Cover = { source: undefined, load() {} };

interface CoverEntry {
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
export class Covers {
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

  /** Check freshness for demanded images. */
  async refresh(force = false) {
    if (this.#destroyed) return;
    if (force) {
      this.#cancelDownloads();
      const cache = this.#selection.cache;
      const signal = this.#scope.signal;
      for (const image of this.#objectUrls.values())
        image.metadata = { ...image.metadata, freshUntil: 0 };
      await cache?.invalidateImages(signal);
      if (signal.aborted || cache !== this.#selection.cache || this.#destroyed) return;
    }
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
    const entry = this.#covers.get(id);
    if (entry?.source === previous.source) entry.source = image.source;
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

  async #resolve(entry: CoverEntry, revalidate: boolean) {
    // Refreshes, reconnects and shared image updates must not acquire offscreen artwork.
    if (!entry.demanded) return;
    const request = ++entry.generation;
    const signal = this.#scope.signal;
    const cache = this.#selection.cache;
    const id = entry.id;
    const valid = () =>
      !this.#destroyed &&
      !signal.aborted &&
      cache === this.#selection.cache &&
      request === entry.generation;
    if (!cache) return;
    try {
      const record = cache.images.get(id);
      const image =
        this.#currentImage(id) ?? (record ? await this.#install(cache, record) : undefined);
      if (!valid()) return;
      if (image && image === this.#currentImage(id)) {
        entry.source = image.source;
        if (revalidate) this.#cacheImage(id);
        return;
      }
    } catch {
      if (!valid()) return;
    }
    if (!valid()) return;
    entry.source = undefined;
    if (revalidate) this.#cacheImage(id);
  }

  /** Refresh only this image's handle, never the whole catalog. */
  #refreshImage(id: string) {
    const entry = this.#covers.get(id);
    return entry?.demanded ? this.#resolve(entry, false) : Promise.resolve();
  }

  #networkConnection() {
    const connection = this.#connection;
    const cache = this.#selection.cache;
    return connection &&
      !connection.signal.aborted &&
      cache?.key === getAccountKey(connection.account)
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
    const force = policy?.freshUntil === 0 || cached?.freshUntil === 0;
    if (!force && policy?.freshUntil !== undefined && policy.freshUntil > Date.now()) return;
    // Legacy records without freshness or validators keep their cache-first behavior.
    if (!force && policy && policy.freshUntil === undefined && !policy.etag && !policy.lastModified)
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, connection.signal, this.#scope.signal]);
    const valid = () =>
      !this.#destroyed &&
      !signal.aborted &&
      cache === this.#selection.cache &&
      this.#networkConnection() === connection;
    this.#downloads.set(id, controller);
    void (async () => {
      const result = await connection.read(id, { ...policy, size: 500, signal });
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
          // Another local operation won: adopt its bytes rather than marking ours as saved.
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

  /** One handle per artwork ID in the selected account. Reading never schedules I/O. */
  ensureCover(id: string | undefined): Cover {
    this.#version;
    if (id === undefined) return emptyCover;
    const existing = this.#covers.get(id);
    if (existing) return existing.cover;
    const engine = this;
    const entry: CoverEntry = $state({
      id,
      generation: 0,
      demanded: false,
      cover: {
        get source() {
          return entry.source;
        },
        load() {
          untrack(() => {
            if (engine.#covers.get(id) !== entry || engine.#destroyed) return;
            entry.demanded = true;
            void engine.#resolve(entry, true);
          });
        },
      },
    });
    this.#covers.set(id, entry);
    return entry.cover;
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
