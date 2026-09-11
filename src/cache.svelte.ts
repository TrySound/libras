import * as v from "valibot";
import {
  artistSchema,
  albumSchema,
  trackSchema,
  imageSchema,
  downloadTrackSchema,
  type Account,
  type ImageRecord,
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
const queueRecordSchema = v.strictObject({ value: queueSchema, updatedAt: timestamp });

const imagesSchema = v.array(imageSchema);
export interface CachedImage {
  blob: Blob;
  type: string;
  etag?: string;
  lastModified?: string;
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

/** Loading one local domain never prevents another from restoring. */
export class CacheLoadError extends AggregateError {
  constructor(
    readonly failures: {
      library?: unknown;
      queue?: unknown;
      images?: unknown;
      downloads?: unknown;
    },
  ) {
    super(
      Object.values(failures),
      Object.entries(failures)
        .map(
          ([domain, error]) =>
            `${domain}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("; "),
    );
    this.name = "CacheLoadError";
  }
}

// Cache serializes complete domain operations, including publication. File I/O
// needs cross-tab locks, but not a second layer of per-instance scheduling.
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

  async #directory(binary = false) {
    const key = await this.key;
    let directory = await navigator.storage.getDirectory();
    for (const name of ["accounts", key, ...(binary ? ["files"] : [])])
      directory = await directory.getDirectoryHandle(name, { create: true });
    return directory;
  }
  directory() {
    return this.#directory(true);
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
    repair = false,
  ): Promise<T | null> {
    let file: File;
    try {
      file = await (await directory.getFileHandle(`${name}.json`)).getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
    // Inaccessible bytes are not corrupt JSON. Never bypass conflict checks by
    // treating a permission or transient read failure as an empty document.
    // An interrupted first write can leave a zero-byte placeholder, not a record.
    if (file.size === 0) return null;
    const text = await file.text();
    try {
      return parse(JSON.parse(text));
    } catch (error) {
      if (repair) return null;
      throw error;
    }
  }
  read<T>(name: DocumentName, parse: (value: unknown) => T) {
    return this.#locked(name, (directory) => this.#read(directory, name, parse));
  }
  update<T>(
    name: DocumentName,
    parse: (value: unknown) => T,
    change: (existing: T | null) => T | undefined,
    options: { valid?: () => boolean; repair?: boolean } = {},
  ): Promise<{ written: boolean; value: T | null }> {
    return this.#locked(name, async (directory) => {
      const existing = await this.#read(directory, name, parse, options.repair);
      const skipped = { written: false, value: existing };
      if (options.valid && !options.valid()) return skipped;
      const value = change(existing);
      if (value === undefined || (options.valid && !options.valid())) return skipped;
      const handle = await directory.getFileHandle(`${name}.json`, { create: true });
      let writable: FileSystemWritableFileStream | undefined;
      let committed = false;
      try {
        writable = await handle.createWritable();
        await writable.write(JSON.stringify(value));
        if (options.valid && !options.valid()) return skipped;
        await writable.close();
        committed = true;
        // Do not throw for cancellation after close: callers must know the disk
        // commit owns its binary files even when they cannot publish locally.
        return { written: true, value };
      } finally {
        if (!committed) {
          await writable?.abort().catch(() => {});
          // This JSON name is shared. Without Web Locks a stale empty-file
          // observation could delete another tab's freshly committed document.
          if (navigator.locks) {
            const file = await handle.getFile().catch(() => null);
            if (file?.size === 0) await directory.removeEntry(`${name}.json`).catch(() => {});
          }
        }
      }
    });
  }
}

interface SnapshotOptions<T, View> {
  document: DocumentName;
  initial: View;
  parse: (value: unknown) => T;
  project: (snapshot: T) => View;
  shouldReplace: (candidate: T, existing: T) => boolean;
}

/** Complete snapshots publish only after persistence. Keep the projected view,
 * not a second copy of the source document. Domain callers prepare owned inputs. */
class SnapshotStore<T, View> {
  #value: View;
  #serial = serial();

  constructor(
    readonly disk: Disk | undefined,
    readonly options: SnapshotOptions<T, View>,
  ) {
    this.#value = $state.raw(options.initial);
  }

  get value() {
    return this.#value;
  }

  load(signal?: AbortSignal): Promise<void> {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      const snapshot = await this.disk?.read(this.options.document, this.options.parse);
      signal?.throwIfAborted();
      this.#value = snapshot == null ? this.options.initial : this.options.project(snapshot);
    });
  }

  async replace(candidate: T, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const disk = this.disk;
    if (!disk) throw new Error("No account selected.");
    return this.#serial(async () => {
      signal?.throwIfAborted();
      const result = await disk.update(
        this.options.document,
        this.options.parse,
        (existing) =>
          existing === null || this.options.shouldReplace(candidate, existing)
            ? candidate
            : undefined,
        // Complete authoritative snapshots can replace corrupt persisted data.
        { valid: () => !signal?.aborted, repair: true },
      );
      signal?.throwIfAborted();
      if (result.value !== null) this.#value = this.options.project(result.value);
    });
  }
}

interface CheckpointRecord<T> {
  readonly value: T;
  readonly updatedAt: number;
}

interface CheckpointOptions<T> {
  document: DocumentName;
  initial: T;
  parse: (value: unknown) => CheckpointRecord<T>;
}

/** Optimistic publication, durable adoption, and revision-aware checkpoints.
 * Values are immutable by contract; domain callers own input preparation. */
class CheckpointStore<T> {
  #record: CheckpointRecord<T>;
  #revision = $state(0);
  #savedRevision = $state(0);
  error = $state.raw<unknown>();
  #serial = serial();
  #debounceTimer?: ReturnType<typeof setTimeout>;
  #checkpointTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly disk: Disk | undefined,
    readonly options: CheckpointOptions<T>,
  ) {
    this.#record = $state.raw({ value: options.initial, updatedAt: 0 });
  }

  get value() {
    return this.#record.value;
  }
  get revision() {
    return this.#revision;
  }
  get dirty() {
    return this.#revision !== this.#savedRevision;
  }

  #adopt(record: CheckpointRecord<T>) {
    this.#record = record;
    this.#savedRevision = ++this.#revision;
    this.error = undefined;
  }

  load(signal?: AbortSignal) {
    const revision = this.#revision;
    return this.#serial(async () => {
      try {
        signal?.throwIfAborted();
        const record = await this.disk?.read(this.options.document, this.options.parse);
        signal?.throwIfAborted();
        // Loading must not discard optimistic edits, including edits made before load().
        if (this.dirty || revision !== this.#revision) return;
        this.#adopt(record ?? { value: this.options.initial, updatedAt: 0 });
      } catch (error) {
        if (!signal?.aborted) this.error = error;
        throw error;
      }
    });
  }

  set(value: T, checkpoint = false) {
    this.#record = { value, updatedAt: Math.max(Date.now(), this.#record.updatedAt + 1) };
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
    // Continuous edits must not starve disk checkpoints.
    this.#checkpointTimer ??= setTimeout(save, 5_000);
  }

  #clearTimers() {
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#checkpointTimer);
    this.#debounceTimer = this.#checkpointTimer = undefined;
  }

  /** Acknowledge only the revision committed; edits during the write stay dirty. */
  flush(): Promise<number> {
    this.#clearTimers();
    return this.#serial(async () => {
      if (!this.dirty) return this.#savedRevision;
      const revision = this.#revision;
      const record = this.#record;
      try {
        const result = await this.disk?.update(
          this.options.document,
          this.options.parse,
          (previous) => (previous && previous.updatedAt > record.updatedAt ? undefined : record),
          { repair: true },
        );
        if (!result?.written)
          throw new Error(
            `A newer ${this.options.document} was saved in another tab. Local edits have not been saved.`,
          );
        this.#savedRevision = revision;
        this.error = undefined;
        return revision;
      } catch (error) {
        this.error = error;
        throw error;
      }
    });
  }

  /** Persist before publication, unless local work or cancellation supersedes it. */
  replace(next: T, signal: AbortSignal): Promise<boolean> {
    const revision = this.#revision;
    const record = { value: next, updatedAt: Math.max(Date.now(), this.#record.updatedAt + 1) };
    const valid = () => !signal.aborted && revision === this.#revision;
    return this.#serial(async () => {
      if (!valid()) return false;
      try {
        const result = await this.disk?.update(
          this.options.document,
          this.options.parse,
          (previous) => (previous && previous.updatedAt > record.updatedAt ? undefined : record),
          { valid, repair: true },
        );
        if (!valid()) {
          // Close cannot be undone. Repair disk from the still-visible local state
          // without advancing the revision for a cancelled adoption.
          if (result?.written) {
            this.#record = {
              ...this.#record,
              updatedAt: Math.max(this.#record.updatedAt, record.updatedAt),
            };
            this.#savedRevision = -1;
            this.#schedule();
          }
          return false;
        }
        if (!result?.written)
          throw new Error(
            `A newer ${this.options.document} is already stored. The incoming snapshot was not saved.`,
          );
        this.#clearTimers();
        this.#adopt(record);
        return true;
      } catch (error) {
        if (!valid()) return false;
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

/** Shared local records and bytes. Acquisition, per-item locks, and winner policy
 * stay in Cache's domain methods. R is immutable; publication replaces the map. */
class BinaryCatalog<R extends BinaryRecord> {
  #records = $state.raw<ReadonlyMap<string, R>>(new Map());
  error = $state.raw<unknown>();
  #loads = $state(0);
  #serial = serial();

  constructor(
    readonly disk: Disk | undefined,
    readonly options: CatalogOptions<R>,
  ) {}

  get records() {
    return this.#records;
  }
  get loading() {
    return this.#loads > 0;
  }

  /** One error boundary per public Cache operation, not per internal I/O step. */
  async operation<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted();
      const value = await action();
      signal?.throwIfAborted();
      this.error = undefined;
      return value;
    } catch (error) {
      if (!signal?.aborted && this.disk) this.error = error;
      throw error;
    }
  }

  #publish(records: readonly R[] | null) {
    this.#records = new Map((records ?? []).map((record) => [this.options.key(record), record]));
  }

  /** Hydration is observable; internal disk rechecks need not show a loading state. */
  async load(signal?: AbortSignal) {
    this.#loads++;
    try {
      await this.operation(() => this.refresh(signal), signal);
    } finally {
      this.#loads--;
    }
  }

  refresh(signal?: AbortSignal) {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      const document = await this.disk?.read(this.options.document, this.options.parse);
      signal?.throwIfAborted();
      this.#publish(document ?? null);
    });
  }

  #update(change: (records: readonly R[]) => readonly R[] | undefined, signal?: AbortSignal) {
    if (!this.disk) throw new Error("No account selected.");
    return this.disk.update(
      this.options.document,
      this.options.parse,
      (records) => change(records ?? []),
      { valid: () => !signal?.aborted },
    );
  }

  /** Return bytes with their matching record, following competing replacements
   * discovered during missing-file repair. No unlisted files are adopted. */
  read(key: string, signal?: AbortSignal) {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      let record = this.#records.get(key);
      if (!record) return null;
      const directory = await this.disk?.directory();
      if (!directory) return null;
      while (record) {
        signal?.throwIfAborted();
        try {
          const file = await (await directory.getFileHandle(record.fileName)).getFile();
          signal?.throwIfAborted();
          if (file.size === record.size) return { file, record };
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
        }
        signal?.throwIfAborted();
        const missing = record.fileName;
        const result = await this.#update((records) => {
          if (records.find((item) => this.options.key(item) === key)?.fileName !== missing)
            return undefined;
          return records.filter((item) => item.fileName !== missing);
        }, signal);
        signal?.throwIfAborted();
        this.#publish(result.value);
        if (!result.value?.some((item) => item.fileName === missing))
          await directory.removeEntry(missing).catch(() => {});
        record = this.#records.get(key);
      }
      return null;
    });
  }

  /** Stream independently; serialize only catalog commit and publication.
   * Preparing the result may open the file, but blob-backed callers need not. */
  async write<T>(
    fileName: string,
    source: ReadableStream<Uint8Array>,
    prepare: (handle: FileSystemFileHandle) => Promise<{ record: R; value: T }>,
    expected: string | undefined,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    signal?.throwIfAborted();
    const directory = await this.disk?.directory();
    if (!directory) throw new Error("No account selected.");
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
        const result = await this.#update((records) => {
          if (records.find((item) => this.options.key(item) === key)?.fileName !== expected)
            return undefined;
          return [...records.filter((item) => this.options.key(item) !== key), record];
        }, signal);
        // Mark ownership BEFORE checking cancellation or doing any further I/O.
        committed = result.written;
        if (committed && expected) await directory.removeEntry(expected).catch(() => {});
        signal?.throwIfAborted();
        this.#publish(result.value);
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
function parseQueue(value: unknown): Immutable<v.InferOutput<typeof queueRecordSchema>> {
  return v.parse(queueRecordSchema, value);
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
  const artists = entityMap(
    [...(snapshot?.artists ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const albums = entityMap(snapshot?.albums ?? []);
  const tracks = entityMap(snapshot?.tracks ?? []);
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
  const candidates = (ids: readonly (string | undefined)[]) => [
    ...new Set(ids.filter((id): id is string => id !== undefined)),
  ];
  const albumArtwork = new Map<string, readonly string[]>();
  for (const album of albums.values())
    albumArtwork.set(
      album.id,
      candidates([
        album.artworkId,
        ...(albumTracks.get(album.id) ?? []).map((track) => track.artworkId),
      ]),
    );
  const artistArtwork = new Map<string, readonly string[]>();
  const firstAlbumArtwork = new Map<string, string | undefined>();
  for (const artist of artists.values()) {
    const related = artistAlbums.get(artist.id) ?? [];
    artistArtwork.set(
      artist.id,
      candidates([
        artist.artworkId,
        ...related.flatMap((album) => albumArtwork.get(album.id) ?? []),
      ]),
    );
    firstAlbumArtwork.set(artist.id, related.find((album) => album.artworkId)?.artworkId);
  }
  const trackArtwork = new Map<string, readonly string[]>();
  for (const track of tracks.values()) {
    const album = albums.get(track.albumId);
    const artist = album && artists.get(album.artistId);
    trackArtwork.set(
      track.id,
      candidates([
        track.artworkId,
        album?.artworkId,
        artist?.artworkId,
        artist && firstAlbumArtwork.get(artist.id),
      ]),
    );
  }
  return {
    savedAt: snapshot?.savedAt,
    lastModified: snapshot?.lastModified,
    artists,
    albums,
    tracks,
    artistAlbums,
    albumTracks,
    artistArtwork,
    albumArtwork,
    trackArtwork,
  };
}

/**
 * Account-scoped local data owner, or an empty unscoped UI fallback.
 * Construction performs no I/O.
 * Collections and records are immutable by contract; consumers never mutate them.
 * Library state is published only after a successful read/commit. Queue edits are
 * optimistic; checkpoints acknowledge only the revision actually committed.
 */
export class Cache {
  readonly account: Readonly<Account> | undefined;
  readonly #library: SnapshotStore<Immutable<LibrarySnapshot>, ReturnType<typeof prepareLibrary>>;
  readonly #disk: Disk | undefined;
  readonly #queue: CheckpointStore<Immutable<CachedQueue>>;
  readonly #images: BinaryCatalog<Immutable<ImageRecord>>;
  readonly #downloads: BinaryCatalog<Immutable<CachedDownload>>;

  /** Omitting the account creates an empty, non-persisting UI fallback. */
  constructor(account?: Account) {
    this.account = account === undefined ? undefined : Object.freeze({ ...account });
    this.#disk = this.account
      ? new Disk(hash(JSON.stringify([this.account.host, this.account.username])))
      : undefined;
    this.#library = new SnapshotStore(this.#disk, {
      document: "library",
      initial: prepareLibrary(null),
      parse: parseLibrary,
      project: prepareLibrary,
      shouldReplace: (candidate, existing) =>
        !(
          (existing.lastModified !== null &&
            candidate.lastModified !== null &&
            existing.lastModified > candidate.lastModified) ||
          (existing.lastModified === candidate.lastModified && existing.savedAt > candidate.savedAt)
        ),
    });
    this.#queue = new CheckpointStore(this.#disk, {
      document: "queue",
      initial: { tracks: [], index: -1, position: 0 },
      parse: parseQueue,
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

  #requireAccount() {
    if (!this.account) throw new Error("No account selected.");
    return this.account;
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
  get artistArtwork() {
    return this.#library.value.artistArtwork;
  }
  get albumArtwork() {
    return this.#library.value.albumArtwork;
  }
  get trackArtwork() {
    return this.#library.value.trackArtwork;
  }
  get images() {
    return this.#images.records;
  }
  get imagesError() {
    return this.#images.error;
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
    if (!this.account) return;
    const [library, queue, images, downloads] = await Promise.allSettled([
      this.#library.load(signal),
      this.#queue.load(signal),
      this.#images.load(signal),
      this.#downloads.load(signal),
    ]);
    signal?.throwIfAborted();
    if (
      library.status === "rejected" ||
      queue.status === "rejected" ||
      images.status === "rejected" ||
      downloads.status === "rejected"
    )
      throw new CacheLoadError({
        ...(library.status === "rejected" ? { library: library.reason } : {}),
        ...(queue.status === "rejected" ? { queue: queue.reason } : {}),
        ...(images.status === "rejected" ? { images: images.reason } : {}),
        ...(downloads.status === "rejected" ? { downloads: downloads.reason } : {}),
      });
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
  get queueError() {
    return this.#queue.error;
  }

  /** Publish a copied queue immediately; disk checkpoints never rewrite the library. */
  setQueue(queue: Immutable<CachedQueue>, options: { checkpoint?: boolean } = {}): number {
    this.#requireAccount();
    const tracks = this.#queue.value.tracks;
    const sameTracks =
      queue.tracks === tracks ||
      (queue.tracks.length === tracks.length &&
        queue.tracks.every((id, index) => id === tracks[index]));
    return this.#queue.set(
      { ...queue, tracks: sameTracks ? tracks : [...queue.tracks] },
      options.checkpoint ?? false,
    );
  }

  /** Save pending edits and return the revision actually committed. */
  flush(): Promise<number> {
    return this.#queue.flush();
  }

  /** Persist incoming queue state before adoption, unless local work supersedes it. */
  async replaceQueue(queue: Immutable<CachedQueue>, signal: AbortSignal): Promise<boolean> {
    this.#requireAccount();
    return this.#queue.replace({ ...queue, tracks: [...queue.tracks] }, signal);
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
   * Commit bytes before the catalog, then publish. A competing replacement wins if
   * it changed the record observed at call time. Return our committed blob and record;
   * callers can readImage() after an undefined result to use the competing winner.
   */
  saveImage(id: string, image: CachedImage, signal?: AbortSignal) {
    return this.#images.operation(async () => {
      this.#requireAccount();
      const record: Immutable<ImageRecord> = {
        id,
        fileName: `${crypto.randomUUID()}.image`,
        type: image.type,
        size: image.blob.size,
        cachedAt: Date.now(),
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

  get downloads() {
    return this.#downloads.records;
  }
  get downloadsError() {
    return this.#downloads.error;
  }
  get downloadsLoading() {
    return this.#downloads.loading;
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

  /** Stream bytes under a per-download lock; publish only after catalog commit.
   * A complete winner is reused and the unused response is cancelled. Different
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
        const disk = this.#disk;
        if (!disk) throw new Error("No account selected.");
        const candidate = {
          track: structuredClone(track) as CachedDownload["track"],
          format,
          contentType,
        };
        const key = downloadKey(candidate.track.id, candidate.format);
        const save = async () => {
          signal.throwIfAborted();
          // Always take the per-file lock before any short-lived catalog lock.
          await this.#downloads.refresh(signal);
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
    return this.#library.replace(structuredClone(snapshot), signal);
  }
}
