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
const queuedDownloadSchema = v.object({
  track: cachedDownloadSchema.entries.track,
  format: downloadFormat,
  contentType: cachedDownloadSchema.entries.contentType,
  status: v.picklist(["queued", "failed"]),
  diagnostic: v.optional(v.literal(downloadFailureDiagnostic)),
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

export async function hashAccountKey(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type DocumentName = "library" | "queue" | "images" | "downloads" | "playlists";

/** Private namespace and atomic JSON I/O. Knows no account settings or runtime indexes. */
class Disk {
  #scope = new AbortController();
  get signal() {
    return this.#scope.signal;
  }

  cancel() {
    this.#scope.abort();
  }

  resume() {
    this.#scope = new AbortController();
  }

  #pending = new Set<Promise<unknown>>();

  #observe<T>(operation: Promise<T>) {
    this.#pending.add(operation);
    void operation.finally(() => this.#pending.delete(operation)).catch(() => {});
    return operation;
  }

  async drain() {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  async deleteAccount() {
    try {
      const root = await navigator.storage.getDirectory();
      const accounts = await root.getDirectoryHandle("accounts");
      await accounts.removeEntry(await this.key, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
  }

  #downloadLocks = new Map<string, Promise<void>>();
  constructor(readonly key: Promise<string>) {
    // Construction starts hashing, but the disk may never be used. Observe a
    // rejection now; awaiting the original promise during I/O still reports it.
    void key.catch(() => {});
  }

  async #directory(signal: AbortSignal) {
    signal.throwIfAborted();
    const key = await this.key;
    signal.throwIfAborted();
    let directory = await navigator.storage.getDirectory();
    for (const name of ["accounts", key]) {
      signal.throwIfAborted();
      directory = await directory.getDirectoryHandle(name, { create: true });
    }
    return directory;
  }
  files() {
    const signal = this.signal;
    return this.#observe(
      (async () => {
        const directory = await this.#directory(signal);
        signal.throwIfAborted();
        return directory.getDirectoryHandle("files", { create: true });
      })(),
    );
  }

  /** Open only the named file, validating fresh metadata without buffering bytes. */
  openBinary(record: BinaryRecord, signal?: AbortSignal): Promise<File | null> {
    signal = AbortSignal.any([this.signal, ...(signal ? [signal] : [])]);
    return this.#observe(this.#openBinary(record, signal));
  }

  async #openBinary(record: BinaryRecord, signal?: AbortSignal): Promise<File | null> {
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

  removeBinary(fileName: string) {
    return this.#observe(
      (async () => {
        await (await this.files()).removeEntry(fileName).catch(() => {});
      })(),
    );
  }

  /** Concrete byte I/O only. Successful close is the cancellation boundary. */
  writeBinary(
    fileName: string,
    source: ReadableStream<Uint8Array>,
    options: { signal?: AbortSignal; expectedSize?: number; nonempty?: boolean } = {},
  ) {
    const signal = AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]);
    return this.#observe(this.#writeBinary(fileName, source, { ...options, signal }));
  }

  async #writeBinary(
    fileName: string,
    source: ReadableStream<Uint8Array>,
    options: { signal?: AbortSignal; expectedSize?: number; nonempty?: boolean } = {},
  ) {
    const { signal, expectedSize, nonempty } = options;
    signal?.throwIfAborted();
    const directory = await this.files();
    let writable: FileSystemWritableFileStream | undefined;
    try {
      signal?.throwIfAborted();
      const handle = await directory.getFileHandle(fileName, { create: true });
      writable = await handle.createWritable();
      let size = 0;
      const measured = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
      await measured.pipeTo(writable, { signal, preventClose: true });
      signal?.throwIfAborted();
      if ((nonempty && !size) || (expectedSize !== undefined && size !== expectedSize))
        throw new Error("Invalid binary size.");
      await writable.close();
      return { handle, size };
    } catch (error) {
      await writable?.abort().catch(() => {});
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  }

  lockDownload<T>(key: string, signal: AbortSignal, operation: () => Promise<T>) {
    signal = AbortSignal.any([this.signal, signal]);
    return this.#observe(this.#lockDownload(key, signal, operation));
  }

  async #lockDownload<T>(key: string, signal: AbortSignal, operation: () => Promise<T>) {
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

  #locked<T>(name: DocumentName, operation: (directory: FileSystemDirectoryHandle) => Promise<T>) {
    const signal = this.signal;
    return this.#observe(
      (async () => {
        signal.throwIfAborted();
        const key = await this.key;
        const run = async () => operation(await this.#directory(signal));
        return navigator.locks
          ? navigator.locks.request(`libras-${name}:${key}.cache`, { signal }, run)
          : run();
      })(),
    );
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
  initial: () => T;
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
    this.#value = $state.raw(options.initial());
  }

  async clear() {
    this.#clearTimers();
    await this.#serial(async () => {});
    this.#value = this.options.initial();
    this.#savedRevision = ++this.#revision;
    this.#loaded = false;
    this.error = undefined;
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
    const scope = this.disk?.signal;
    if (scope?.aborted) return;
    if (this.#loaded) return;
    const revision = this.#revision;
    return this.#serial(async () => {
      signal?.throwIfAborted();
      if (scope?.aborted || this.#loaded) return;
      try {
        const value = await this.disk?.read(this.options.document, this.options.parse);
        signal?.throwIfAborted();
        if (scope?.aborted) return;
        if (!this.dirty && revision === this.#revision) {
          this.#value = value ?? this.options.initial();
          this.#savedRevision = ++this.#revision;
          this.error = undefined;
        }
        this.#loaded = true;
      } catch (error) {
        if (scope?.aborted) return;
        if (!signal?.aborted) this.error = error;
        throw error;
      }
    });
  }

  set(value: T, checkpoint = false) {
    if (!this.disk) throw new Error("No cache storage configured.");
    if (this.disk.signal.aborted) return this.#revision;
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
    const scope = this.disk?.signal;
    this.#clearTimers();
    return this.#serial(async () => {
      if (scope?.aborted || !this.dirty) return;
      this.#clearTimers();
      const revision = this.#revision;
      const value = this.#value;
      try {
        await this.disk?.write(this.options.document, this.options.serialize(value));
        if (scope?.aborted) return;
        this.#savedRevision = revision;
        this.#loaded = true;
        this.error = undefined;
        await this.options.saved?.(revision);
      } catch (error) {
        if (scope?.aborted) return;
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

/** Image records use reactive checkpoints; obsolete bytes retire only after acknowledgement. */
class ImageStore {
  #pending = new Set<Promise<unknown>>();

  async clear() {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    await this.#serial(async () => {});
    await this.store.clear();
    this.#obsolete.clear();
    this.#error = undefined;
  }

  readonly store: CheckpointStore<SvelteMap<string, Immutable<ImageRecord>>>;
  #error = $state.raw<unknown>();
  #serial = serial();
  // Only filenames, not old catalogs or binary data, survive until a checkpoint.
  #obsolete = new Map<string, number>();

  constructor(readonly disk: Disk | undefined) {
    this.store = new CheckpointStore<SvelteMap<string, Immutable<ImageRecord>>>(disk, {
      document: "images",
      initial: () => new SvelteMap(),
      parse: (value) => new SvelteMap(parseImages(value).map((record) => [record.id, record])),
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
  get records(): ReadonlyMap<string, Immutable<ImageRecord>> {
    return this.store.value;
  }

  /** One error boundary per public Cache operation, not per internal I/O step. */
  operation<T>(action: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disk) signal = signal ? AbortSignal.any([this.disk.signal, signal]) : this.disk.signal;
    const pending = (async () => {
      try {
        signal?.throwIfAborted();
        const value = await action(signal);
        signal?.throwIfAborted();
        this.#error = undefined;
        return value;
      } catch (error) {
        if (!signal?.aborted && this.disk) this.#error = error;
        throw error;
      }
    })();
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => {});
    return pending;
  }

  /** Hydration does not open binary files. */
  async load(signal?: AbortSignal) {
    await this.operation((scope) => this.store.load(scope), signal);
  }

  #replace(key: string, next?: Immutable<ImageRecord>) {
    if (this.disk?.signal.aborted) return;
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
    change: (record: Immutable<ImageRecord>) => Immutable<ImageRecord> | undefined,
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
  updateMetadata(metadata: ImageMetadata, signal?: AbortSignal) {
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

  /** Stream independently, then serialize image publication without reopening bytes. */
  async write(
    record: Immutable<ImageRecord>,
    blob: Blob,
    expected: string | undefined,
    signal?: AbortSignal,
  ) {
    await this.store.load(signal);
    if (!this.disk) throw new Error("No cache storage configured.");
    await this.disk.writeBinary(record.fileName, blob.stream(), {
      signal,
      expectedSize: record.size,
    });
    let published = false;
    try {
      await this.#serial(async () => {
        signal?.throwIfAborted();
        if (this.records.get(record.id)?.fileName !== expected) return;
        this.#replace(record.id, record);
        published = true;
      });
      return published ? { blob, record } : undefined;
    } finally {
      if (!published) await this.disk.removeBinary(record.fileName).catch(() => {});
    }
  }
}

/** Explicit durable download jobs and their registered bytes, scoped to one disk. */
class DownloadStore {
  readonly #disk: Disk | undefined;
  #downloads = $state.raw<ReadonlyMap<string, DownloadEntry>>(new Map());
  #downloadError = $state.raw<unknown>();
  #downloadSerial = serial();
  #downloadsLoaded = false;
  #downloadsBlocked = false;
  #downloadsReady = false;

  constructor(disk: Disk | undefined) {
    this.#disk = disk;
  }

  async clear() {
    await this.#downloadSerial(async () => {});
    this.#downloads = new Map();
    this.#downloadsLoaded = false;
    this.#downloadsBlocked = false;
    this.#downloadsReady = false;
    this.#downloadError = undefined;
  }

  #requireDisk() {
    if (!this.#disk) throw new Error("No cache storage configured.");
    this.#disk.signal.throwIfAborted();
    return this.#disk;
  }

  get error() {
    return this.#downloadError;
  }

  /** Metadata-queue barrier only: neither hydrates nor joins active byte transfers. */
  flush() {
    if (this.#disk?.signal.aborted) return Promise.resolve();
    return this.#downloadOperation(() => this.#downloadSerial(async () => {}));
  }

  get downloadStorageBlocked() {
    return this.#downloadsBlocked;
  }

  async #downloadOperation<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const scope = this.#disk?.signal;
    try {
      scope?.throwIfAborted();
      return await action();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      scope?.throwIfAborted();
      this.#downloadError = new DownloadError();
      throw this.#downloadError;
    }
  }

  async #writeDownloads(records: ReadonlyMap<string, DownloadEntry>) {
    if (this.#downloadsBlocked) throw new DownloadError();
    await this.#requireDisk().write("downloads", { version: 2, records: [...records.values()] });
    this.#disk?.signal.throwIfAborted();
    this.#downloads = records;
    this.#downloadsLoaded = true;
    this.#downloadError = undefined;
  }

  /** Legacy arrays migrate atomically; a denied conversion stays read-only.
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
        this.#requireDisk();
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
      this.#disk?.signal.throwIfAborted();
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
    return this.enqueueDownloads([{ track, format, contentType }], retry).then(
      (entries) => entries[0]!,
    );
  }

  enqueueDownloads(
    requests: readonly Immutable<Pick<DownloadEntry, "track" | "format" | "contentType">>[],
    retry = false,
  ) {
    const selected = requests.map(({ track, format, contentType }) => ({
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        contentType: track.contentType,
      },
      format,
      contentType,
    }));
    return this.#downloadOperation(() =>
      this.#downloadSerial(async () => {
        await this.#loadDownloads();
        const records = new Map(this.downloads);
        const entries: DownloadEntry[] = [];
        let changed = false;
        for (const { track, format, contentType } of selected) {
          const key = downloadKey(track.id, format);
          const existing = records.get(key);
          if (existing && (!retry || existing.status !== "failed")) {
            entries.push(existing);
            continue;
          }
          const entry = v.parse(queuedDownloadSchema, {
            track: existing?.track ?? track,
            format,
            contentType: existing?.contentType ?? contentType,
            status: "queued",
          });
          if (retry) {
            records.delete(key);
          }
          records.set(key, entry);
          entries.push(entry);
          changed = true;
        }
        if (changed) {
          await this.#writeDownloads(records);
          this.#downloadsReady = false;
        }
        return entries;
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
          if (!this.#disk?.signal.aborted) this.#downloads = records;
          throw error;
        }
      }),
    );
  }

  /** Caller freezes, aborts and joins workers before removing all unfinished intent. */
  cancelPendingDownloads() {
    return this.#downloadOperation(() =>
      this.#downloadSerial(async () => {
        await this.#loadDownloads();
        const records = new Map(
          [...this.downloads].filter(([, item]) => item.status === "completed"),
        );
        await this.#writeDownloads(records);
      }),
    );
  }

  /** Validate only registered completed files, without buffering audio. */
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

  get downloads(): ReadonlyMap<string, DownloadEntry> {
    return this.#downloads;
  }

  /** Reconciliation failures do not prevent read-only use of committed bytes or format fallback. */
  async readDownload(
    trackId: string,
    format: DownloadFormat,
    signal?: AbortSignal,
  ): Promise<File | null> {
    if (this.#disk)
      signal = signal ? AbortSignal.any([this.#disk.signal, signal]) : this.#disk.signal;
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

  /** Durable intent -> fresh bytes -> close -> completed publication. Never adopt orphan bytes. */
  async saveDownload(
    track: Immutable<CachedDownload["track"]>,
    format: DownloadFormat,
    contentType: string,
    response: Response,
    signal: AbortSignal,
  ): Promise<File> {
    if (this.#disk) signal = AbortSignal.any([this.#disk.signal, signal]);
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
        if (!response.body) throw new DownloadError();
        const fileName = `${crypto.randomUUID()}.audio`;
        // CORS may hide encoding headers; Fetch itself enforces HTTP framing.
        const length = response.headers.get("content-length");
        const expectedSize =
          response.type !== "cors" && !response.headers.get("content-encoding") && length !== null
            ? Number(length)
            : undefined;
        const { handle, size } = await disk.writeBinary(fileName, response.body, {
          signal,
          expectedSize,
          nonempty: true,
        });
        // Successful byte close wins cancellation. Callers join this publication.
        await this.#downloadSerial(async () => {
          const records = new Map(this.downloads);
          records.set(key, {
            track: safeTrack,
            format,
            contentType,
            fileName,
            size,
            downloadedAt: Date.now(),
            status: "completed",
          });
          try {
            await this.#writeDownloads(records);
          } catch (error) {
            // A close can commit and then report an error. Verify only canonical
            // registered records; never infer completion from unregistered bytes.
            let canonical;
            try {
              canonical = await disk.read("downloads", (value) => {
                const parsed = v.parse(downloadStoreSchema, value);
                validateDownloadEntries(parsed.records);
                return parsed.records;
              });
            } catch {
              this.#downloadsBlocked = true;
              throw error; // Unknown outcome: preserve potentially referenced bytes.
            }
            const committed = canonical?.find(
              (item) => item.status === "completed" && item.fileName === fileName,
            );
            if (disk.signal.aborted) throw error;
            if (committed?.status === "completed") {
              const confirmed = new Map(this.downloads);
              confirmed.set(downloadKey(committed.track.id, committed.format), committed);
              this.#downloads = confirmed;
              this.#downloadError = undefined;
            } else {
              await disk.removeBinary(fileName).catch(() => {});
              throw error;
            }
          }
        });
        return await handle.getFile();
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

function validateDownloadEntries(records: v.InferOutput<typeof downloadStoreSchema>["records"]) {
  unique(records, (item) => downloadKey(item.track.id, item.format));
  unique(
    records.flatMap((item) => (item.status === "completed" ? [item.fileName] : [])),
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
  readonly #images: ImageStore;
  readonly #downloads: DownloadStore;
  #clearing?: Promise<void>;

  /** Omitting the key creates an empty, non-persisting UI fallback.
   * Keys are opaque identities; hashing and storage addressing stay internal. */
  constructor(key?: string) {
    this.key = key;
    this.#disk = key === undefined ? undefined : new Disk(hashAccountKey(key));
    this.#library = new CheckpointStore(this.#disk, {
      document: "library",
      initial: () => prepareLibrary(null),
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
      initial: () => ({ tracks: [], index: -1, position: 0 }),
      parse: (value) => v.parse(queueSchema, value),
      serialize: (value) => value,
    });
    this.#playlists = new CheckpointStore<Immutable<CachedPlaylists>>(this.#disk, {
      document: "playlists",
      initial: () => ({ listedAt: null, summaries: [], details: [] }),
      parse: (value) => v.parse(playlistsSchema, value),
      serialize: (value) => value,
    });
    this.#images = new ImageStore(this.#disk);
    this.#downloads = new DownloadStore(this.#disk);
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

  /** Clear only this account's OPFS data. Session retains ownership throughout. */
  clear(): Promise<void> {
    if (this.#clearing) return this.#clearing;
    const disk = this.#disk;
    disk?.cancel();
    return (this.#clearing = (async () => {
      await disk?.drain();
      await Promise.all([
        this.#library.clear(),
        this.#queue.clear(),
        this.#playlists.clear(),
        this.#images.clear(),
        this.#downloads.clear(),
      ]);
      await disk?.deleteAccount();
    })().finally(() => {
      disk?.resume();
      this.#clearing = undefined;
    }));
  }

  /** Restore independent local domains, reporting failures after all finish. */
  async load(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#disk) return;
    const scope = this.#disk.signal;
    const results = await Promise.allSettled([
      this.#library.load(signal),
      this.#queue.load(signal),
      this.#playlists.load(signal),
      this.#images.load(signal),
      this.loadDownloads(signal),
    ]);
    signal?.throwIfAborted();
    if (scope.aborted) return;
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

  /** Queue durability is independent of every other domain. */
  flushQueue(): Promise<void> {
    return this.#queue.flush();
  }

  /** Stop disk publication after producers have stopped and final checkpoints settled. */
  async retire() {
    await this.#clearing?.catch(() => {});
    try {
      await this.flush();
    } finally {
      this.#disk?.cancel();
      await this.#disk?.drain();
    }
  }

  /** Checkpoint independent documents, waiting for every attempt before reporting failure. */
  async flush(): Promise<void> {
    const results = await Promise.allSettled([
      this.#library.flush(),
      this.#queue.flush(),
      this.#playlists.flush(),
      this.#images.store.flush(),
      this.#downloads.flush(),
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
      this.#downloads.error,
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
    return this.#downloads.downloadStorageBlocked;
  }

  enqueueDownload(
    track: Immutable<CachedDownload["track"]>,
    format: DownloadFormat,
    contentType: string,
    retry = false,
  ) {
    return this.#downloads.enqueueDownload(track, format, contentType, retry);
  }

  enqueueDownloads(
    requests: readonly Immutable<Pick<DownloadEntry, "track" | "format" | "contentType">>[],
    retry = false,
  ) {
    return this.#downloads.enqueueDownloads(requests, retry);
  }

  failDownload(key: string, known?: Pick<DownloadEntry, "track" | "format" | "contentType">) {
    return this.#downloads.failDownload(key, known);
  }

  cancelPendingDownloads() {
    return this.#downloads.cancelPendingDownloads();
  }

  loadDownloads(signal?: AbortSignal) {
    return this.#downloads.loadDownloads(signal);
  }

  get dirty() {
    return (
      this.#library.dirty || this.#queue.dirty || this.#playlists.dirty || this.#images.store.dirty
    );
  }

  /** Load bytes on demand. Missing/incomplete files invalidate only their matching record. */
  readImage(id: string, signal?: AbortSignal) {
    const images = this.#images;
    return images.operation(async (signal) => {
      const opened = await images.read(id, signal);
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
    const images = this.#images;
    return images.operation(async (signal) => {
      this.#requireDisk();
      await images.store.load(signal);
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
      const expected = images.records.get(id)?.fileName;
      return images.write(record, blob, expected, signal);
    }, signal);
  }

  /** Mark all artwork stale while retaining its bytes and validators for offline use. */
  invalidateImages(signal?: AbortSignal) {
    return this.#images.operation(
      (signal) => this.#images.updateMetadata({ freshUntil: 0 }, signal),
      signal,
    );
  }

  /** A 304 changes freshness/validators, not the file or its URL. */
  updateImage(id: string, expected: string, metadata: ImageMetadata, signal?: AbortSignal) {
    return this.#images.operation(
      (signal) =>
        this.#images.updateRecord(id, expected, (record) => ({ ...record, ...metadata }), signal),
      signal,
    );
  }

  /** Evict only the observed version, preserving any competing replacement. */
  evictImage(id: string, expected: string, signal?: AbortSignal) {
    return this.#images.operation(
      (signal) => this.#images.updateRecord(id, expected, () => undefined, signal),
      signal,
    );
  }

  get downloads(): ReadonlyMap<string, DownloadEntry> {
    return this.#downloads.downloads;
  }

  readDownload(
    trackId: string,
    format: DownloadFormat,
    signal?: AbortSignal,
  ): Promise<File | null> {
    return this.#downloads.readDownload(trackId, format, signal);
  }

  saveDownload(
    track: Immutable<CachedDownload["track"]>,
    format: DownloadFormat,
    contentType: string,
    response: Response,
    signal: AbortSignal,
  ): Promise<File> {
    return this.#downloads.saveDownload(track, format, contentType, response, signal);
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
