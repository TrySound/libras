import * as v from "valibot";
import { SvelteMap } from "svelte/reactivity";
import {
  artistSchema,
  albumSchema,
  trackSchema,
  imageSchema,
  downloadTrackSchema,
  type ImageRecord,
  type ImageMetadata,
  type Album,
  type Track,
} from "./schema";

/** Read-only selection dependency. Session is the application's only selector. */
export interface CacheSelection {
  readonly cache: Cache | undefined;
}

export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const librarySchema = v.strictObject({
  lastModified: v.nullable(timestamp),
  savedAt: timestamp,
  artists: v.array(artistSchema),
  albums: v.array(albumSchema),
  tracks: v.array(trackSchema),
});
export type LibrarySnapshot = v.InferOutput<typeof librarySchema>;

const queueFields = {
  tracks: v.array(v.pipe(v.string(), v.minLength(1))),
  index: v.pipe(v.number(), v.integer(), v.minValue(-1)),
  position: v.pipe(v.number(), v.finite(), v.minValue(0)),
};
function validSelection(queue: { tracks: readonly string[]; index: number; position: number }) {
  return queue.index < queue.tracks.length && (queue.index !== -1 || queue.position === 0);
}
const queueSchema = v.pipe(
  v.strictObject(queueFields),
  v.check((queue) => validSelection(queue), "Invalid queue selection."),
);
export type CachedQueue = v.InferOutput<typeof queueSchema>;

const imagesSchema = v.array(imageSchema);
export interface CachedImage extends ImageMetadata {
  blob: Blob;
  type: string;
}

const downloadFormat = v.picklist(["raw", "mp3"]);
export type DownloadFormat = v.InferOutput<typeof downloadFormat>;
const cachedDownloadSchema = v.strictObject({
  track: v.strictObject({ ...downloadTrackSchema.entries, id: v.pipe(v.string(), v.minLength(1)) }),
  format: downloadFormat,
  contentType: v.pipe(v.string(), v.minLength(1)),
  fileName: v.pipe(v.string(), v.regex(/^[a-f0-9-]+\.audio$/)),
  size: v.pipe(v.number(), v.integer(), v.minValue(1)),
  downloadedAt: timestamp,
});
export type CachedDownload = v.InferOutput<typeof cachedDownloadSchema>;
const downloadsSchema = v.array(cachedDownloadSchema);
/** Account-local identity, also distinguishing original files from MP3 transcodes. */
export function downloadKey(trackId: string, format: DownloadFormat) {
  return JSON.stringify([trackId, format]);
}

// Order hydration/checkpoints and short binary-record operations independently.
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

async function hash(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type DocumentName = "library" | "queue" | "images" | "downloads";

/** Private namespace and atomic JSON I/O. Knows no account settings or runtime indexes. */
class Disk {
  constructor(readonly key: Promise<string>) {
    // Construction starts hashing, but the disk may never be used. Observe a
    // rejection now; awaiting the original promise during I/O still reports it.
    void key.catch(() => {});
  }

  async #directory() {
    const key = await this.key;
    let directory = await navigator.storage.getDirectory();
    for (const name of ["accounts", key])
      directory = await directory.getDirectoryHandle(name, { create: true });
    return directory;
  }
  async files() {
    return (await this.#directory()).getDirectoryHandle("files", { create: true });
  }

  async lockDownload<T>(key: string, signal: AbortSignal, operation: () => Promise<T>) {
    signal.throwIfAborted();
    const name = `libras-download:${await this.key}:${key}.audio`;
    signal.throwIfAborted();
    return navigator.locks ? navigator.locks.request(name, { signal }, operation) : operation();
  }

  async #locked<T>(
    name: DocumentName,
    operation: (directory: FileSystemDirectoryHandle) => Promise<T>,
  ) {
    const key = await this.key;
    const run = async () => operation(await this.#directory());
    return navigator.locks ? navigator.locks.request(`libras-${name}:${key}.cache`, run) : run();
  }
  async #read<T>(
    directory: FileSystemDirectoryHandle,
    name: DocumentName,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    let file: File;
    try {
      file = await (await directory.getFileHandle(`${name}.json`)).getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
    // An interrupted first write can leave a zero-byte placeholder, not a record.
    // All other read/validation failures propagate; catalogs must not start empty.
    if (file.size === 0) return null;
    const text = await file.text();
    return parse(JSON.parse(text));
  }
  read<T>(name: DocumentName, parse: (value: unknown) => T) {
    return this.#locked(name, (directory) => this.#read(directory, name, parse));
  }
  write(name: DocumentName, value: unknown): Promise<void> {
    return this.#locked(name, async (directory) => {
      const handle = await directory.getFileHandle(`${name}.json`, { create: true });
      let writable: FileSystemWritableFileStream | undefined;
      let committed = false;
      try {
        writable = await handle.createWritable();
        await writable.write(JSON.stringify(value));
        await writable.close();
        committed = true;
      } finally {
        if (!committed) await writable?.abort().catch(() => {});
      }
    });
  }
}

interface CheckpointOptions<T> {
  document: DocumentName;
  initial: T;
  parse: (value: unknown) => T;
  serialize: (value: T) => unknown;
  saved?: (revision: number) => Promise<void>;
}

/** Memory is authoritative after hydration. Only flushes allocate disk snapshots. */
class CheckpointStore<T> {
  #value: T;
  #revision = $state(0);
  #savedRevision = $state(0);
  #loaded = false;
  error = $state.raw<unknown>();
  #serial = serial();
  #debounceTimer?: ReturnType<typeof setTimeout>;
  #checkpointTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly disk: Disk | undefined,
    readonly options: CheckpointOptions<T>,
  ) {
    this.#value = $state.raw(options.initial);
  }

  get value() {
    return this.#value;
  }
  get revision() {
    return this.#revision;
  }
  get dirty() {
    return this.#revision !== this.#savedRevision;
  }

  async load(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#loaded) return;
    const revision = this.#revision;
    return this.#serial(async () => {
      signal?.throwIfAborted();
      if (this.#loaded) return;
      try {
        const value = await this.disk?.read(this.options.document, this.options.parse);
        signal?.throwIfAborted();
        if (!this.dirty && revision === this.#revision) {
          this.#value = value ?? this.options.initial;
          this.#savedRevision = ++this.#revision;
          this.error = undefined;
        }
        this.#loaded = true;
      } catch (error) {
        if (!signal?.aborted) this.error = error;
        throw error;
      }
    });
  }

  set(value: T, checkpoint = false) {
    if (!this.disk) throw new Error("No cache storage configured.");
    this.#value = value;
    const revision = ++this.#revision;
    this.#schedule(checkpoint);
    return revision;
  }

  #schedule(checkpoint = false) {
    const save = () => {
      void this.flush().catch(() => {});
    };
    if (!checkpoint) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = setTimeout(save, 300);
    }
    this.#checkpointTimer ??= setTimeout(save, 5_000);
  }

  #clearTimers() {
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#checkpointTimer);
    this.#debounceTimer = this.#checkpointTimer = undefined;
  }

  /** Capture at write time, never per edit. Later edits remain dirty. */
  flush(): Promise<void> {
    this.#clearTimers();
    return this.#serial(async () => {
      if (!this.dirty) return;
      this.#clearTimers();
      const revision = this.#revision;
      const value = this.#value;
      try {
        await this.disk?.write(this.options.document, this.options.serialize(value));
        this.#savedRevision = revision;
        this.#loaded = true;
        this.error = undefined;
        await this.options.saved?.(revision);
      } catch (error) {
        this.error = error;
        throw error;
      }
    });
  }
}

interface BinaryRecord {
  readonly fileName: string;
  readonly size: number;
}

interface CatalogOptions<R> {
  document: DocumentName;
  parse: (value: unknown) => readonly R[];
  key: (record: R) => string;
}

/** Bytes stream directly to disk; records share the ordinary checkpoint path. */
class BinaryCatalog<R extends BinaryRecord> {
  readonly store: CheckpointStore<SvelteMap<string, R>>;
  #error = $state.raw<unknown>();
  #serial = serial();
  // Only filenames, not old catalogs or binary data, survive until a checkpoint.
  #obsolete = new Map<string, number>();

  constructor(
    readonly disk: Disk | undefined,
    readonly options: CatalogOptions<R>,
  ) {
    this.store = new CheckpointStore<SvelteMap<string, R>>(disk, {
      document: options.document,
      initial: new SvelteMap<string, R>(),
      parse: (value) =>
        new SvelteMap(options.parse(value).map((record) => [options.key(record), record])),
      // Capture membership synchronously before disk I/O yields. Records themselves
      // are immutable, so subsequent edits cannot change an in-flight checkpoint.
      serialize: (records) => [...records.values()],
      saved: async (revision) => {
        const obsolete = [...this.#obsolete].filter(([, removedAt]) => removedAt <= revision);
        if (obsolete.length === 0) return;
        const directory = await disk?.files().catch(() => undefined);
        if (!directory) return;
        for (const [fileName] of obsolete) {
          await directory.removeEntry(fileName).catch(() => {});
          this.#obsolete.delete(fileName);
        }
      },
    });
  }

  get error() {
    return this.store.error ?? this.#error;
  }
  get records(): ReadonlyMap<string, R> {
    return this.store.value;
  }

  /** One error boundary per public Cache operation, not per internal I/O step. */
  async operation<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted();
      const value = await action();
      signal?.throwIfAborted();
      this.#error = undefined;
      return value;
    } catch (error) {
      if (!signal?.aborted && this.disk) this.#error = error;
      throw error;
    }
  }

  /** Hydration does not open binary files. */
  async load(signal?: AbortSignal) {
    await this.operation(() => this.store.load(signal), signal);
  }

  #replace(key: string, next?: R) {
    const previous = this.records.get(key);
    const records = this.store.value;
    if (next) records.set(key, next);
    else records.delete(key);
    const revision = this.store.set(records);
    if (previous && previous.fileName !== next?.fileName)
      this.#obsolete.set(previous.fileName, revision);
  }

  /** Return bytes with their matching in-memory record. No unlisted files are adopted. */
  read(key: string, signal?: AbortSignal) {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      await this.store.load(signal);
      const record = this.records.get(key);
      if (!record) return null;
      const directory = await this.disk?.files();
      if (!directory) return null;
      signal?.throwIfAborted();
      try {
        const file = await (await directory.getFileHandle(record.fileName)).getFile();
        signal?.throwIfAborted();
        if (file.size === record.size) return { file, record };
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
      }
      signal?.throwIfAborted();
      this.#replace(key);
      return null;
    });
  }

  /** Update metadata (or evict) without rewriting bytes; never overwrite a replacement. */
  updateRecord(
    key: string,
    expected: string,
    change: (record: R) => R | undefined,
    signal?: AbortSignal,
  ) {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      await this.store.load(signal);
      signal?.throwIfAborted();
      const record = this.records.get(key);
      if (record?.fileName === expected) this.#replace(key, change(record));
    });
  }

  /** Update catalog metadata in one publication without changing file ownership. */
  updateMetadata(metadata: Partial<R>, signal?: AbortSignal) {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      await this.store.load(signal);
      signal?.throwIfAborted();
      const records = this.store.value;
      if (!records.size) return;
      for (const [key, record] of records) records.set(key, { ...record, ...metadata });
      this.store.set(records);
    });
  }

  /** Stream independently; serialize only in-memory catalog publication.
   * Preparing the result may open the file, but blob-backed callers need not. */
  async write<T>(
    fileName: string,
    source: ReadableStream<Uint8Array>,
    prepare: (handle: FileSystemFileHandle) => Promise<{ record: R; value: T }>,
    expected: string | undefined,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    signal?.throwIfAborted();
    await this.store.load(signal);
    const directory = await this.disk?.files();
    if (!directory) throw new Error("No cache storage configured.");
    let writable: FileSystemWritableFileStream | undefined;
    let committed = false;
    try {
      signal?.throwIfAborted();
      const handle = await directory.getFileHandle(fileName, { create: true });
      writable = await handle.createWritable();
      await source.pipeTo(writable, { signal });
      signal?.throwIfAborted();
      const { record, value } = await prepare(handle);
      const key = this.options.key(record);
      await this.#serial(async () => {
        signal?.throwIfAborted();
        if (this.records.get(key)?.fileName !== expected) return;
        this.#replace(key, record);
        committed = true;
      });
      return committed ? value : undefined;
    } finally {
      if (!committed) {
        await writable?.abort().catch(() => {});
        await directory.removeEntry(fileName).catch(() => {});
      }
    }
  }
}

function unique<T>(records: readonly T[], key: (record: T) => string) {
  if (new Set(records.map(key)).size !== records.length)
    throw new Error("Duplicate cache references.");
}
function parseLibrary(value: unknown): Immutable<LibrarySnapshot> {
  const record = v.parse(librarySchema, value);
  for (const records of [record.artists, record.albums, record.tracks])
    unique<{ id: string }>(records, (item) => item.id);
  return record;
}
function parseImages(value: unknown): Immutable<v.InferOutput<typeof imagesSchema>> {
  const catalog = v.parse(imagesSchema, value);
  unique(catalog, (image) => image.id);
  unique(catalog, (image) => image.fileName);
  return catalog;
}
function parseDownloads(value: unknown): Immutable<v.InferOutput<typeof downloadsSchema>> {
  const catalog = v.parse(downloadsSchema, value);
  unique(catalog, (item) => downloadKey(item.track.id, item.format));
  unique(catalog, (item) => item.fileName);
  return catalog;
}

function entityMap<T extends { readonly id: string }>(
  records: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

function groupBy<T>(
  records: Iterable<T>,
  key: (record: T) => string,
  compare: (a: T, b: T) => number,
) {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const id = key(record);
    const group = groups.get(id) ?? [];
    group.push(record);
    groups.set(id, group);
  }
  for (const group of groups.values()) group.sort(compare);
  return groups as ReadonlyMap<string, readonly T[]>;
}

function prepareLibrary(snapshot: Immutable<LibrarySnapshot> | null) {
  let artistsList = (snapshot?.artists ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  if (import.meta.env.VITE_STRESS_ARTISTS === "1") {
    artistsList = artistsList.flatMap((artist) =>
      Array.from({ length: 100 }, (_, index) =>
        index === 0
          ? artist
          : { ...artist, id: `${artist.id}--stress-${index}`, name: `${artist.name} (${index})` },
      ),
    );
  }
  const artists = entityMap(artistsList);
  // Older offline snapshots stored only explicit artwork references. Normalize
  // once at the data boundary, just like fresh network metadata.
  const albums = entityMap<Immutable<Album>>(
    (snapshot?.albums ?? []).map((album) => ({
      ...album,
      artworkId: album.artworkId ?? artists.get(album.artistId)?.artworkId,
    })),
  );
  const tracks = entityMap<Immutable<Track>>(
    (snapshot?.tracks ?? []).map((track) => ({
      ...track,
      artworkId: track.artworkId ?? albums.get(track.albumId)?.artworkId,
    })),
  );
  const artistAlbums = groupBy(
    albums.values(),
    (album) => album.artistId,
    (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title),
  );
  const albumTracks = groupBy(
    tracks.values(),
    (track) => track.albumId,
    (a, b) =>
      (a.disc ?? 1) - (b.disc ?? 1) ||
      (a.number ?? Infinity) - (b.number ?? Infinity) ||
      a.title.localeCompare(b.title),
  );
  return {
    savedAt: snapshot?.savedAt,
    lastModified: snapshot?.lastModified,
    artists,
    albums,
    tracks,
    artistAlbums,
    albumTracks,
  };
}

/**
 * Key-scoped local data owner, or an empty unscoped UI fallback.
 * Construction performs no I/O.
 * Consumers never mutate collections or records. Library maps are snapshots;
 * binary catalogs are read-only live reactive views with immutable records.
 * Mutations publish in memory; checkpoints acknowledge only the revision committed.
 * OPFS is read once per document, not reconciled with other cache instances.
 */
export class Cache {
  readonly key: string | undefined;
  readonly #library: CheckpointStore<ReturnType<typeof prepareLibrary>>;
  readonly #disk: Disk | undefined;
  readonly #queue: CheckpointStore<Immutable<CachedQueue>>;
  readonly #images: BinaryCatalog<Immutable<ImageRecord>>;
  readonly #downloads: BinaryCatalog<Immutable<CachedDownload>>;

  /** Omitting the key creates an empty, non-persisting UI fallback.
   * Keys are opaque identities; hashing and storage addressing stay internal. */
  constructor(key?: string) {
    this.key = key;
    this.#disk = key === undefined ? undefined : new Disk(hash(key));
    this.#library = new CheckpointStore(this.#disk, {
      document: "library",
      initial: prepareLibrary(null),
      parse: (value) => prepareLibrary(parseLibrary(value)),
      serialize: (value) => ({
        savedAt: value.savedAt,
        lastModified: value.lastModified,
        artists: [...value.artists.values()],
        albums: [...value.albums.values()],
        tracks: [...value.tracks.values()],
      }),
    });
    this.#queue = new CheckpointStore<Immutable<CachedQueue>>(this.#disk, {
      document: "queue",
      initial: { tracks: [], index: -1, position: 0 },
      parse: (value) => v.parse(queueSchema, value),
      serialize: (value) => value,
    });
    this.#images = new BinaryCatalog(this.#disk, {
      document: "images",
      parse: parseImages,
      key: (image) => image.id,
    });
    this.#downloads = new BinaryCatalog(this.#disk, {
      document: "downloads",
      parse: parseDownloads,
      key: (item) => downloadKey(item.track.id, item.format),
    });
  }

  #requireDisk() {
    if (!this.#disk) throw new Error("No cache storage configured.");
    return this.#disk;
  }

  get artists() {
    return this.#library.value.artists;
  }
  get albums() {
    return this.#library.value.albums;
  }
  get tracks() {
    return this.#library.value.tracks;
  }
  get artistAlbums() {
    return this.#library.value.artistAlbums;
  }
  get albumTracks() {
    return this.#library.value.albumTracks;
  }
  get images() {
    return this.#images.records;
  }

  get lastModified() {
    return this.#library.value.lastModified;
  }
  get savedAt() {
    return this.#library.value.savedAt;
  }

  /** Restore independent local domains, reporting failures after all finish. */
  async load(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#disk) return;
    const results = await Promise.allSettled([
      this.#library.load(signal),
      this.#queue.load(signal),
      this.#images.load(signal),
      this.#downloads.load(signal),
    ]);
    signal?.throwIfAborted();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Could not restore cache.");
  }

  get queue() {
    return this.#queue.value;
  }
  get queueRevision() {
    return this.#queue.revision;
  }
  get queueDirty() {
    return this.#queue.dirty;
  }

  /** Publish a copied queue immediately; disk checkpoints never rewrite the library. */
  setQueue(queue: Immutable<CachedQueue>, options: { checkpoint?: boolean } = {}): number {
    this.#requireDisk();
    const tracks = this.queue.tracks;
    return this.#queue.set(
      { ...queue, tracks: queue.tracks === tracks ? tracks : [...queue.tracks] },
      options.checkpoint ?? false,
    );
  }

  /** Checkpoint independent documents, waiting for every attempt before reporting failure. */
  async flush(): Promise<void> {
    const results = await Promise.allSettled([
      this.#library.flush(),
      this.#queue.flush(),
      this.#images.store.flush(),
      this.#downloads.store.flush(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Could not save cache.");
  }

  #error = $derived.by(() => {
    const errors = [
      this.#library.error,
      this.#queue.error,
      this.#images.error,
      this.#downloads.error,
    ].filter((error) => error !== undefined);
    return errors.length ? new AggregateError(errors, "Cache failed.") : undefined;
  });

  get error() {
    return this.#error;
  }
  get dirty() {
    return (
      this.#library.dirty ||
      this.#queue.dirty ||
      this.#images.store.dirty ||
      this.#downloads.store.dirty
    );
  }

  /** Load bytes on demand. Missing/incomplete files invalidate only their matching record. */
  readImage(id: string, signal?: AbortSignal) {
    return this.#images.operation(async () => {
      const opened = await this.#images.read(id, signal);
      if (!opened) return null;
      const { file, record } = opened;
      return { blob: new Blob([await file.arrayBuffer()], { type: record.type }), record };
    }, signal);
  }

  /**
   * Close bytes, then publish the record in memory. A competing local replacement wins if
   * it changed the record observed at call time. Return our blob and record;
   * callers can readImage() after an undefined result to use the competing winner.
   */
  saveImage(id: string, image: CachedImage, signal?: AbortSignal) {
    return this.#images.operation(async () => {
      this.#requireDisk();
      await this.#images.store.load(signal);
      signal?.throwIfAborted();
      const record: Immutable<ImageRecord> = {
        id,
        fileName: `${crypto.randomUUID()}.image`,
        type: image.type,
        size: image.blob.size,
        cachedAt: Date.now(),
        cacheControl: image.cacheControl,
        expires: image.expires,
        freshUntil: image.freshUntil,
        etag: image.etag,
        lastModified: image.lastModified,
      };
      const blob = new Blob([image.blob], { type: record.type });
      const expected = this.images.get(id)?.fileName;
      return this.#images.write(
        record.fileName,
        blob.stream(),
        async () => ({ record, value: { blob, record } }),
        expected,
        signal,
      );
    }, signal);
  }

  /** Mark all artwork stale while retaining its bytes and validators for offline use. */
  invalidateImages(signal?: AbortSignal) {
    return this.#images.operation(
      () => this.#images.updateMetadata({ freshUntil: 0 }, signal),
      signal,
    );
  }

  /** A 304 changes freshness/validators, not the file or its URL. */
  updateImage(id: string, expected: string, metadata: ImageMetadata, signal?: AbortSignal) {
    return this.#images.operation(
      () =>
        this.#images.updateRecord(id, expected, (record) => ({ ...record, ...metadata }), signal),
      signal,
    );
  }

  /** Evict only the observed version, preserving any competing replacement. */
  evictImage(id: string, expected: string, signal?: AbortSignal) {
    return this.#images.operation(
      () => this.#images.updateRecord(id, expected, () => undefined, signal),
      signal,
    );
  }

  get downloads() {
    return this.#downloads.records;
  }

  /** Open a file lazily without copying audio into RAM or adopting unlisted bytes. */
  readDownload(
    trackId: string,
    format: DownloadFormat,
    signal?: AbortSignal,
  ): Promise<File | null> {
    return this.#downloads.operation(async () => {
      const opened = await this.#downloads.read(downloadKey(trackId, format), signal);
      return opened?.file ?? null;
    }, signal);
  }

  /** Stream bytes under a per-download lock, then publish the record in memory.
   * A complete local winner is reused and the unused response is cancelled. Different
   * downloads stream concurrently; only short catalog operations are serialized.
   */
  async saveDownload(
    track: Immutable<CachedDownload["track"]>,
    format: DownloadFormat,
    contentType: string,
    response: Response,
    signal: AbortSignal,
  ): Promise<File> {
    try {
      return await this.#downloads.operation(async () => {
        const disk = this.#requireDisk();
        const candidate = {
          track: structuredClone(track) as CachedDownload["track"],
          format,
          contentType,
        };
        const key = downloadKey(candidate.track.id, candidate.format);
        const save = async () => {
          signal.throwIfAborted();
          const cached = await this.#downloads.read(key, signal);
          if (cached) return cached.file;
          const expected = this.downloads.get(key)?.fileName;
          const fileName = `${crypto.randomUUID()}.audio`;
          if (!response.body) throw new Error("The downloaded audio response has no body.");
          const file = await this.#downloads.write(
            fileName,
            response.body,
            async (handle) => {
              const file = await handle.getFile();
              return {
                record: { ...candidate, fileName, size: file.size, downloadedAt: Date.now() },
                value: file,
              };
            },
            expected,
            signal,
          );
          if (file) return file;
          const winner = await this.#downloads.read(key, signal);
          if (!winner) throw new Error("The competing download is no longer available.");
          return winner.file;
        };
        return disk.lockDownload(key, signal, save);
      }, signal);
    } finally {
      if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  async replaceLibrary(snapshot: Immutable<LibrarySnapshot>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#requireDisk();
    const current = this.#library.value;
    if (
      (current.lastModified != null &&
        snapshot.lastModified !== null &&
        current.lastModified > snapshot.lastModified) ||
      (current.lastModified === snapshot.lastModified &&
        current.savedAt !== undefined &&
        current.savedAt > snapshot.savedAt)
    )
      return;
    this.#library.set(prepareLibrary(structuredClone(snapshot)));
  }
}
