import * as v from "valibot";
import { DownloadError, downloadFailureDiagnostic, withoutDownloadErrors } from "./download-error";
import { SvelteMap } from "svelte/reactivity";
import {
  artistSchema,
  albumSchema,
  trackSchema,
  imageSchema,
  downloadTrackSchema,
  playlistSchema,
  playlistDetailSchema,
  type Playlist,
  type PlaylistDetail,
  type ImageRecord,
  type ImageMetadata,
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

const playlistsSchema = v.strictObject({
  // Undefined list freshness is represented by listedAt = null, not an empty server list.
  listedAt: v.nullable(timestamp),
  summaries: v.array(playlistSchema),
  details: v.array(playlistDetailSchema),
});
export type CachedPlaylists = v.InferOutput<typeof playlistsSchema>;

const imagesSchema = v.array(imageSchema);
interface CachedImage extends ImageMetadata {
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
type CachedDownload = v.InferOutput<typeof cachedDownloadSchema>;
const downloadsSchema = v.array(cachedDownloadSchema);
const queuedDownloadSchema = v.strictObject({
  track: cachedDownloadSchema.entries.track,
  format: downloadFormat,
  contentType: cachedDownloadSchema.entries.contentType,
  status: v.picklist(["queued", "failed"]),
  diagnostic: v.optional(v.literal(downloadFailureDiagnostic)),
  attempt: v.optional(
    v.strictObject({
      fileName: cachedDownloadSchema.entries.fileName,
      size: v.nullable(cachedDownloadSchema.entries.size),
      downloadedAt: timestamp,
    }),
  ),
});
const completedDownloadSchema = v.strictObject({
  ...cachedDownloadSchema.entries,
  status: v.literal("completed"),
});
const downloadEntrySchema = v.variant("status", [queuedDownloadSchema, completedDownloadSchema]);
const downloadStoreSchema = v.strictObject({
  version: v.literal(2),
  records: v.array(downloadEntrySchema),
});
export type DownloadEntry = Immutable<v.InferOutput<typeof downloadEntrySchema>>;
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

type DocumentName = "library" | "queue" | "images" | "downloads" | "playlists";

/** Private namespace and atomic JSON I/O. Knows no account settings or runtime indexes. */
class Disk {
  #downloadLocks = new Map<string, Promise<void>>();
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

  /** Open only the named file, validating fresh metadata without buffering bytes. */
  async openBinary(record: BinaryRecord, signal?: AbortSignal): Promise<File | null> {
    signal?.throwIfAborted();
    try {
      const directory = await this.files();
      signal?.throwIfAborted();
      const file = await (await directory.getFileHandle(record.fileName)).getFile();
      signal?.throwIfAborted();
      return file.size === record.size ? file : null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async lockDownload<T>(key: string, signal: AbortSignal, operation: () => Promise<T>) {
    signal.throwIfAborted();
    const name = `libras-download:${await this.key}:${key}.audio`;
    signal.throwIfAborted();
    if (navigator.locks) return navigator.locks.request(name, { signal }, operation);
    const result = (this.#downloadLocks.get(key) ?? Promise.resolve()).then(() => {
      signal.throwIfAborted();
      return operation();
    });
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#downloadLocks.set(key, tail);
    void tail.then(() => {
      if (this.#downloadLocks.get(key) === tail) this.#downloadLocks.delete(key);
    });
    return result;
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
    if (file.size === 0 && name !== "downloads") return null;
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
      if (!this.disk) return null;
      const file = await this.disk.openBinary(record, signal);
      if (file) return { file, record };
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

function validateDownloadEntries(records: readonly DownloadEntry[]) {
  unique(records, (item) => downloadKey(item.track.id, item.format));
  unique(
    records.flatMap((item) =>
      item.status === "completed" ? [item.fileName] : item.attempt ? [item.attempt.fileName] : [],
    ),
    (name) => name,
  );
}

function entityMap<T extends { readonly id: string }>(
  records: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

function groupBy<T>(
  records: Iterable<T>,
  keys: (record: T) => readonly string[],
  compare: (a: T, b: T) => number,
) {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    for (const id of new Set(keys(record))) {
      const group = groups.get(id) ?? [];
      group.push(record);
      groups.set(id, group);
    }
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
  const albums = entityMap(snapshot?.albums ?? []);
  const tracks = entityMap(snapshot?.tracks ?? []);
  const albumTracks = groupBy(
    tracks.values(),
    (track) => [track.albumId],
    (a, b) =>
      (a.disc ?? 1) - (b.disc ?? 1) ||
      (a.number ?? Infinity) - (b.number ?? Infinity) ||
      a.title.localeCompare(b.title),
  );
  // Track-only contributors should also be able to browse their appearances.
  // groupBy deduplicates credits without changing the album's stored artists.
  const artistAlbums = groupBy(
    albums.values(),
    (album) => [
      ...album.artistIds,
      ...(albumTracks.get(album.id) ?? []).flatMap((track) => track.artistIds),
    ],
    (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title),
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
 * Consumers never mutate collections or records. Library and download maps are snapshots;
 * image catalogs are read-only live reactive views with immutable records.
 * Mutations publish in memory; checkpoints acknowledge only the revision committed.
 * OPFS is read once per document, not reconciled with other cache instances.
 */
export class Cache {
  readonly key: string | undefined;
  readonly #library: CheckpointStore<ReturnType<typeof prepareLibrary>>;
  readonly #disk: Disk | undefined;
  readonly #queue: CheckpointStore<Immutable<CachedQueue>>;
  readonly #playlists: CheckpointStore<Immutable<CachedPlaylists>>;
  readonly #images: BinaryCatalog<Immutable<ImageRecord>>;
  #downloads = $state.raw<ReadonlyMap<string, DownloadEntry>>(new Map());
  #downloadError = $state.raw<unknown>();
  #downloadSerial = serial();
  #downloadsLoaded = false;
  #downloadsBlocked = false;
  #downloadsReady = false;

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
    this.#playlists = new CheckpointStore<Immutable<CachedPlaylists>>(this.#disk, {
      document: "playlists",
      initial: { listedAt: null, summaries: [], details: [] },
      parse: (value) => v.parse(playlistsSchema, value),
      serialize: (value) => value,
    });
    this.#images = new BinaryCatalog(this.#disk, {
      document: "images",
      parse: parseImages,
      key: (image) => image.id,
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
      this.#playlists.load(signal),
      this.#images.load(signal),
      this.loadDownloads(signal),
    ]);
    signal?.throwIfAborted();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Could not restore cache.");
  }

  get playlists() {
    return this.#playlists.value;
  }

  /** Server-confirmed state is published immediately; durability is an independent checkpoint. */
  setPlaylists(value: Immutable<CachedPlaylists>) {
    this.#requireDisk();
    this.#playlists.set(structuredClone(value));
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
      this.#playlists.flush(),
      this.#images.store.flush(),
      this.#downloadOperation(() => this.#downloadSerial(async () => {})),
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
      this.#playlists.error,
      this.#images.error,
      this.#downloadError,
    ].filter((error) => error !== undefined);
    return errors.length ? new AggregateError(errors, "Cache failed.") : undefined;
  });

  get error() {
    return this.#error;
  }
  get reportingError() {
    return withoutDownloadErrors(this.error);
  }
  get downloadStorageBlocked() {
    return this.#downloadsBlocked;
  }

  async #downloadOperation<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.#downloadError = new DownloadError();
      throw this.#downloadError;
    }
  }

  async #writeDownloads(records: ReadonlyMap<string, DownloadEntry>) {
    if (this.#downloadsBlocked) throw new DownloadError();
    await this.#requireDisk().write("downloads", { version: 2, records: [...records.values()] });
    this.#downloads = records;
    this.#downloadsLoaded = true;
    this.#downloadError = undefined;
  }

  /** The shipped completed-only array migrates atomically; its fallback stays read-only.
   * Unknown documents block writes. Unshipped split-store files are never consulted. */
  async #loadDownloads(signal?: AbortSignal, reconcile = false) {
    if (this.#downloadsLoaded && (!reconcile || this.#downloadsReady)) return;
    let records = this.downloads;
    let migrate = false;
    if (!this.#downloadsLoaded) {
      try {
        const stored = await this.#requireDisk().read("downloads", (value) => {
          if (Array.isArray(value))
            return {
              legacy: true,
              records: parseDownloads(value).map((item) => ({
                ...item,
                status: "completed" as const,
              })),
            };
          const parsed = v.parse(downloadStoreSchema, value);
          validateDownloadEntries(parsed.records);
          return { legacy: false, records: parsed.records };
        });
        signal?.throwIfAborted();
        migrate = stored?.legacy ?? false;
        const restored = new Map<string, DownloadEntry>(
          (stored?.records ?? []).map((item) => [downloadKey(item.track.id, item.format), item]),
        );
        // Retain attributable memory-only failures when retrying a denied migration.
        for (const [key, failure] of this.downloads) {
          if (failure.status !== "failed") continue;
          const completed = restored.get(key);
          if (
            completed?.status === "completed" &&
            (await this.#requireDisk().openBinary(completed, signal))
          )
            continue;
          restored.set(key, failure);
        }
        records = restored;
      } catch (error) {
        if (!signal?.aborted) this.#downloadsBlocked = true;
        throw error;
      }
      this.#downloadsBlocked = false;
      this.#downloads = records;
      // Readable legacy bytes are usable, but cannot authorize subset writeback.
      this.#downloadsLoaded = !migrate;
    }
    let next: Map<string, DownloadEntry> | undefined;
    const incomplete: string[] = [];
    for (const [key, entry] of records) {
      signal?.throwIfAborted();
      if (entry.status === "completed") {
        if (!(await this.#requireDisk().openBinary(entry, signal))) {
          incomplete.push(entry.fileName);
          next ??= new Map(records);
          next.delete(key);
          next.set(key, {
            track: entry.track,
            format: entry.format,
            contentType: entry.contentType,
            status: "queued",
          });
        }
      } else if (
        entry.status === "queued" &&
        entry.attempt?.size &&
        (await this.#requireDisk().openBinary(
          { ...entry.attempt, size: entry.attempt.size },
          signal,
        ))
      ) {
        next ??= new Map(records);
        next.set(key, {
          track: entry.track,
          format: entry.format,
          contentType: entry.contentType,
          ...entry.attempt,
          size: entry.attempt.size,
          status: "completed",
        });
      }
    }
    signal?.throwIfAborted();
    if (migrate || next) await this.#writeDownloads(next ?? records);
    this.#downloadsReady = true;
    if (incomplete.length) {
      const directory = await this.#requireDisk().files();
      for (const fileName of incomplete) await directory.removeEntry(fileName).catch(() => {});
    }
  }

  /** Acknowledges queued state only after canonical close. Retry moves to the FIFO tail. */
  enqueueDownload(
    track: Immutable<CachedDownload["track"]>,
    format: DownloadFormat,
    contentType: string,
    retry = false,
  ) {
    const safeTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      contentType: track.contentType,
    };
    return this.#downloadOperation(() =>
      this.#downloadSerial(async () => {
        await this.#loadDownloads();
        const key = downloadKey(track.id, format);
        const existing = this.downloads.get(key);
        if (existing && (!retry || existing.status !== "failed")) return existing;
        const entry = v.parse(queuedDownloadSchema, {
          track: existing?.track ?? safeTrack,
          format,
          contentType: existing?.contentType ?? contentType,
          status: "queued",
          ...(existing?.status === "failed" && existing.attempt
            ? { attempt: existing.attempt }
            : {}),
        });
        const records = new Map(this.downloads);
        if (retry) records.delete(key);
        records.set(key, entry);
        await this.#writeDownloads(records);
        this.#downloadsReady = false;
        return entry;
      }),
    );
  }

  failDownload(key: string, known?: Pick<DownloadEntry, "track" | "format" | "contentType">) {
    return this.#downloadOperation(() =>
      this.#downloadSerial(async () => {
        let loadError: unknown;
        try {
          await this.#loadDownloads();
        } catch (error) {
          loadError = error;
        }
        const previous = this.downloads.get(key);
        if (previous?.status === "completed") return;
        const description =
          previous ??
          (known && {
            track: {
              id: known.track.id,
              title: known.track.title,
              artist: known.track.artist,
              album: known.track.album,
              contentType: known.track.contentType,
            },
            format: known.format,
            contentType: known.contentType,
          });
        if (!description) {
          if (loadError) throw loadError;
          return;
        }
        const failed = v.parse(queuedDownloadSchema, {
          ...description,
          status: "failed",
          diagnostic: downloadFailureDiagnostic,
        });
        const records = new Map(this.downloads);
        records.set(key, failed);
        try {
          if (loadError) throw loadError;
          await this.#writeDownloads(records);
        } catch (error) {
          // Safe known-track presentation survives persistence denial; never overwrite unknown disk state.
          this.#downloads = records;
          throw error;
        }
      }),
    );
  }

  /** Caller freezes, aborts and joins workers before removing only queued entries. */
  cancelPendingDownloads() {
    return this.#downloadOperation(() =>
      this.#downloadSerial(async () => {
        await this.#loadDownloads();
        const pending = [...this.downloads.values()].filter((item) => item.status === "queued");
        const records = new Map([...this.downloads].filter(([, item]) => item.status !== "queued"));
        await this.#writeDownloads(records);
        const directory = await this.#requireDisk().files();
        for (const item of pending) {
          if (item.status === "queued" && item.attempt)
            await directory.removeEntry(item.attempt.fileName).catch(() => {});
        }
      }),
    );
  }

  /** Named-file metadata only: never buffer audio to validate recovery. */
  loadDownloads(signal?: AbortSignal) {
    if (!this.#disk) return Promise.resolve();
    return this.#downloadOperation(
      () =>
        this.#downloadSerial(async () => {
          signal?.throwIfAborted();
          await this.#loadDownloads(signal, true);
        }),
      signal,
    );
  }

  get dirty() {
    return (
      this.#library.dirty || this.#queue.dirty || this.#playlists.dirty || this.#images.store.dirty
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

  get downloads(): ReadonlyMap<string, DownloadEntry> {
    return this.#downloads;
  }

  /** Reconciliation failures do not prevent read-only use of committed bytes or format fallback. */
  async readDownload(
    trackId: string,
    format: DownloadFormat,
    signal?: AbortSignal,
  ): Promise<File | null> {
    signal?.throwIfAborted();
    if (!this.#disk) return null;
    try {
      const key = downloadKey(trackId, format);
      await this.loadDownloads(signal).catch((error) => {
        // Download-domain failures do not gate independent saved-file or online playback.
        if (signal?.aborted) throw error;
      });
      const record = this.downloads.get(key);
      if (record?.status !== "completed") return null;
      const file = await this.#requireDisk().openBinary(record, signal);
      if (file) return file;
      // Legacy fallback is read-only until the complete migration has committed.
      if (this.#downloadsLoaded && !this.#downloadsBlocked)
        await this.#downloadSerial(async () => {
          signal?.throwIfAborted();
          if (this.downloads.get(key) !== record) return;
          const records = new Map(this.downloads);
          records.delete(key);
          records.set(key, {
            track: record.track,
            format,
            contentType: record.contentType,
            status: "queued",
          });
          await this.#writeDownloads(records);
          const directory = await this.#requireDisk().files();
          await directory.removeEntry(record.fileName).catch(() => {});
        }).catch((error) => {
          if (signal?.aborted) throw error;
          this.#downloadError = new DownloadError();
        });
      return null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.#downloadError = new DownloadError();
      throw this.#downloadError;
    }
  }

  /** Reservation -> measured exhausted size -> atomic byte close -> single completed publication.
   * Closed bytes remain owned by queued state if the final commit fails. */
  async saveDownload(
    track: Immutable<CachedDownload["track"]>,
    format: DownloadFormat,
    contentType: string,
    response: Response,
    signal: AbortSignal,
  ): Promise<File> {
    const safeTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      contentType: track.contentType,
    };
    try {
      const disk = this.#requireDisk();
      const key = downloadKey(track.id, format);
      return await disk.lockDownload(key, signal, async () => {
        signal.throwIfAborted();
        const cached = await this.readDownload(track.id, format, signal);
        if (cached) return cached;
        const intent = await this.enqueueDownload(safeTrack, format, contentType);
        if (intent?.status === "failed") throw new DownloadError();
        const attempt = {
          fileName: `${crypto.randomUUID()}.audio`,
          size: null as number | null,
          downloadedAt: Date.now(),
        };
        const prepare = () =>
          this.#downloadSerial(async () => {
            signal.throwIfAborted();
            const records = new Map(this.downloads);
            const current = records.get(key);
            if (!current || current.status !== "queued") throw new DownloadError();
            records.set(key, { ...current, attempt: { ...attempt } });
            await this.#writeDownloads(records);
            if (current.attempt && current.attempt.fileName !== attempt.fileName) {
              const directory = await disk.files();
              await directory.removeEntry(current.attempt.fileName).catch(() => {});
            }
          });
        await prepare();
        const directory = await disk.files();
        signal.throwIfAborted();
        const handle = await directory.getFileHandle(attempt.fileName, { create: true });
        let writable: FileSystemWritableFileStream | undefined;
        let closed = false;
        try {
          if (!response.body) throw new DownloadError();
          writable = await handle.createWritable();
          let size = 0;
          const measured = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                size += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
          );
          await measured.pipeTo(writable, { signal, preventClose: true });
          signal.throwIfAborted();
          if (!size) throw new DownloadError();
          // Cross-origin encoding headers may be hidden. Fetch enforces HTTP
          // framing; only check the exposed length when encoding is knowable.
          const length = response.headers.get("content-length");
          if (
            response.type !== "cors" &&
            !response.headers.get("content-encoding") &&
            length !== null &&
            Number(length) !== size
          )
            throw new DownloadError();
          attempt.size = size;
          await prepare();
          signal.throwIfAborted();
          await writable.close();
          closed = true;
          this.#downloadsReady = false;
          // Once close has succeeded, finish completed publication even during teardown.
          // Explicit cancel joins this boundary before acknowledging cancellation.
          await this.#downloadSerial(async () => {
            const records = new Map(this.downloads);
            records.set(key, {
              track: safeTrack,
              format,
              contentType,
              ...attempt,
              size,
              status: "completed",
            });
            await this.#writeDownloads(records);
          });
          return await handle.getFile();
        } finally {
          if (!closed) {
            await writable?.abort().catch(() => {});
            await directory.removeEntry(attempt.fileName).catch(() => {});
          }
        }
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const safeError = new DownloadError();
      if (this.#disk) this.#downloadError = safeError;
      throw safeError;
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
