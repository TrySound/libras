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
const queueRecordSchema = v.pipe(
  v.strictObject({ ...queueFields, updatedAt: timestamp }),
  v.check((queue) => validSelection(queue), "Invalid queue selection."),
);
export type CachedQueue = Omit<v.InferOutput<typeof queueRecordSchema>, "updatedAt">;

const imagesSchema = v.strictObject({ images: v.array(imageSchema) });
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
const downloadsSchema = v.strictObject({ downloads: v.array(cachedDownloadSchema) });
/** Account-local identity, also distinguishing original files from MP3 transcodes. */
export function downloadKey(trackId: string, format: DownloadFormat) {
  return JSON.stringify([trackId, format]);
}
function downloadMap(
  records: readonly CachedDownload[],
): ReadonlyMap<string, Immutable<CachedDownload>> {
  const map = new Map<string, Immutable<CachedDownload>>();
  for (const record of records) map.set(downloadKey(record.track.id, record.format), record);
  return map;
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

function unique<T>(records: readonly T[], key: (record: T) => string) {
  if (new Set(records.map(key)).size !== records.length)
    throw new Error("Duplicate cache references.");
}
function parseLibrary(value: unknown) {
  const record = v.parse(librarySchema, value);
  for (const records of [record.artists, record.albums, record.tracks])
    unique<{ id: string }>(records, (item) => item.id);
  return record;
}
function parseQueue(value: unknown) {
  return v.parse(queueRecordSchema, value);
}
function parseImages(value: unknown) {
  const catalog = v.parse(imagesSchema, value);
  unique(catalog.images, (image) => image.id);
  unique(catalog.images, (image) => image.fileName);
  return catalog;
}
function parseDownloads(value: unknown) {
  const catalog = v.parse(downloadsSchema, value);
  unique(catalog.downloads, (item) => downloadKey(item.track.id, item.format));
  unique(catalog.downloads, (item) => item.fileName);
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
  #library = $state.raw(prepareLibrary(null));
  readonly #disk: Disk | undefined;
  #runLibrary = serial();
  #queue = $state.raw<Immutable<CachedQueue>>({ tracks: [], index: -1, position: 0 });
  #queueRevision = $state(0);
  #queueSavedRevision = $state(0);
  #queueError = $state.raw<unknown>();
  #queueUpdatedAt = 0;
  #runQueue = serial();
  #queueTimer?: ReturnType<typeof setTimeout>;
  #checkpointTimer?: ReturnType<typeof setTimeout>;
  #images = $state.raw<ReadonlyMap<string, Immutable<ImageRecord>>>(new Map());
  #imagesError = $state.raw<unknown>();
  #runImages = serial();
  #downloads = $state.raw<ReadonlyMap<string, Immutable<CachedDownload>>>(new Map());
  #downloadsError = $state.raw<unknown>();
  #runDownloads = serial();
  #downloadLoads = $state(0);

  /** Omitting the account creates an empty, non-persisting UI fallback. */
  constructor(account?: Account) {
    this.account = account === undefined ? undefined : Object.freeze({ ...account });
    this.#disk = this.account
      ? new Disk(hash(JSON.stringify([this.account.host, this.account.username])))
      : undefined;
  }

  #requireAccount() {
    if (!this.account) throw new Error("No account selected.");
    return this.account;
  }

  get artists() {
    return this.#library.artists;
  }
  get albums() {
    return this.#library.albums;
  }
  get tracks() {
    return this.#library.tracks;
  }
  get artistAlbums() {
    return this.#library.artistAlbums;
  }
  get albumTracks() {
    return this.#library.albumTracks;
  }
  get artistArtwork() {
    return this.#library.artistArtwork;
  }
  get albumArtwork() {
    return this.#library.albumArtwork;
  }
  get trackArtwork() {
    return this.#library.trackArtwork;
  }
  get images() {
    return this.#images;
  }
  get imagesError() {
    return this.#imagesError;
  }

  get lastModified() {
    return this.#library.lastModified;
  }
  get savedAt() {
    return this.#library.savedAt;
  }

  /** Restore independent local domains, reporting failures after all finish. */
  async load(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.account) return;
    const [library, queue, images, downloads] = await Promise.allSettled([
      this.#loadLibrary(signal),
      this.#loadQueue(signal),
      this.#loadImages(signal),
      this.#hydrateDownloads(signal),
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

  #loadLibrary(signal?: AbortSignal): Promise<void> {
    return this.#runLibrary(async () => {
      signal?.throwIfAborted();
      const record = await this.#disk?.read("library", parseLibrary);
      signal?.throwIfAborted();
      this.#library = prepareLibrary(record ?? null);
    });
  }

  get queue() {
    return this.#queue;
  }
  get queueRevision() {
    return this.#queueRevision;
  }
  get queueDirty() {
    return this.#queueRevision !== this.#queueSavedRevision;
  }
  get queueError() {
    return this.#queueError;
  }

  #loadQueue(signal?: AbortSignal) {
    const revision = this.#queueRevision;
    return this.#runQueue(async () => {
      try {
        signal?.throwIfAborted();
        const record = await this.#disk?.read("queue", parseQueue);
        signal?.throwIfAborted();
        // Loading must not discard optimistic edits, including edits made before load().
        if (this.queueDirty || revision !== this.#queueRevision) return;
        this.#queue = record
          ? { tracks: record.tracks, index: record.index, position: record.position }
          : { tracks: [], index: -1, position: 0 };
        this.#queueUpdatedAt = record?.updatedAt ?? 0;
        this.#queueSavedRevision = ++this.#queueRevision;
        this.#queueError = undefined;
      } catch (error) {
        if (!signal?.aborted) this.#queueError = error;
        throw error;
      }
    });
  }

  /** Publish a copied queue immediately; disk checkpoints never rewrite the library. */
  setQueue(queue: Immutable<CachedQueue>, options: { checkpoint?: boolean } = {}): number {
    this.#requireAccount();
    const sameTracks =
      queue.tracks === this.#queue.tracks ||
      (queue.tracks.length === this.#queue.tracks.length &&
        queue.tracks.every((id, index) => id === this.#queue.tracks[index]));
    this.#queue = {
      ...queue,
      tracks: sameTracks ? this.#queue.tracks : [...queue.tracks],
    };
    this.#queueUpdatedAt = Math.max(Date.now(), this.#queueUpdatedAt + 1);
    const revision = ++this.#queueRevision;
    this.#scheduleQueue(options.checkpoint ?? false);
    return revision;
  }

  #scheduleQueue(checkpoint = false) {
    const save = () => {
      void this.flush().catch(() => {});
    };
    if (!checkpoint) {
      clearTimeout(this.#queueTimer);
      this.#queueTimer = setTimeout(save, 300);
    }
    // Continuous playback position updates must not starve disk checkpoints.
    this.#checkpointTimer ??= setTimeout(save, 5_000);
  }

  /**
   * Save pending local edits and return the revision actually committed. Edits made
   * during the write remain dirty and keep their own scheduled checkpoint.
   * Failures reject here and remain observable through queueError for timer saves.
   */
  flush(): Promise<number> {
    clearTimeout(this.#queueTimer);
    clearTimeout(this.#checkpointTimer);
    this.#queueTimer = this.#checkpointTimer = undefined;
    return this.#runQueue(async () => {
      if (!this.queueDirty) return this.#queueSavedRevision;
      const revision = this.#queueRevision;
      const record = {
        ...this.#queue,
        tracks: [...this.#queue.tracks],
        updatedAt: this.#queueUpdatedAt,
      };
      try {
        const result = await this.#disk?.update(
          "queue",
          parseQueue,
          (previous) => (previous && previous.updatedAt > record.updatedAt ? undefined : record),
          { repair: true },
        );
        if (!result?.written)
          throw new Error("A newer queue was saved in another tab. This queue has not been saved.");
        this.#queueSavedRevision = revision;
        this.#queueError = undefined;
        return revision;
      } catch (error) {
        this.#queueError = error;
        throw error;
      }
    });
  }

  /** Persist incoming queue state before adoption, unless local work supersedes it. */
  async replaceQueue(queue: Immutable<CachedQueue>, signal: AbortSignal): Promise<boolean> {
    this.#requireAccount();
    const next: CachedQueue = { ...queue, tracks: [...queue.tracks] };
    const revision = this.#queueRevision;
    const updatedAt = Math.max(Date.now(), this.#queueUpdatedAt + 1);
    const valid = () => !signal.aborted && revision === this.#queueRevision;
    return this.#runQueue(async () => {
      if (!valid()) return false;
      try {
        const result = await this.#disk?.update(
          "queue",
          parseQueue,
          (previous) =>
            previous && previous.updatedAt > updatedAt ? undefined : { ...next, updatedAt },
          { valid, repair: true },
        );
        if (!valid()) {
          // Atomic close cannot be undone. Checkpoint the still-visible local queue
          // if cancellation arrived during close, without granting upload eligibility.
          if (result?.written) {
            this.#queueUpdatedAt = Math.max(this.#queueUpdatedAt, updatedAt);
            this.#queueSavedRevision = -1;
            this.#scheduleQueue();
          }
          return false;
        }
        if (!result?.written)
          throw new Error("A newer queue is already stored. The server snapshot was not saved.");
        clearTimeout(this.#queueTimer);
        clearTimeout(this.#checkpointTimer);
        this.#queueTimer = this.#checkpointTimer = undefined;
        this.#queue = next;
        this.#queueUpdatedAt = updatedAt;
        this.#queueSavedRevision = ++this.#queueRevision;
        this.#queueError = undefined;
        return true;
      } catch (error) {
        if (!valid()) return false;
        this.#queueError = error;
        throw error;
      }
    });
  }

  #loadImages(signal?: AbortSignal) {
    return this.#runImages(async () => {
      try {
        signal?.throwIfAborted();
        const catalog = await this.#disk?.read("images", parseImages);
        signal?.throwIfAborted();
        this.#images = entityMap(catalog?.images ?? []);
        this.#imagesError = undefined;
      } catch (error) {
        if (!signal?.aborted) this.#imagesError = error;
        throw error;
      }
    });
  }

  /** Load bytes on demand. Missing/incomplete files invalidate only their matching record. */
  readImage(id: string, signal?: AbortSignal): Promise<Blob | null> {
    return this.#runImages(async () => {
      try {
        signal?.throwIfAborted();
        const record = this.#images.get(id);
        if (!record) return null;
        const directory = await this.#disk?.directory();
        if (!directory) return null;
        try {
          const file = await (await directory.getFileHandle(record.fileName)).getFile();
          if (file.size !== record.size)
            throw new DOMException("The cached image is incomplete.", "DataError");
          const blob = new Blob([await file.arrayBuffer()], { type: record.type });
          signal?.throwIfAborted();
          this.#imagesError = undefined;
          return blob;
        } catch (error) {
          if (
            !(error instanceof DOMException) ||
            !["NotFoundError", "DataError"].includes(error.name)
          )
            throw error;
        }
        signal?.throwIfAborted();
        const result = await this.#disk?.update(
          "images",
          parseImages,
          (catalog) => {
            if (catalog?.images.find((image) => image.id === id)?.fileName !== record.fileName)
              return undefined;
            return { ...catalog!, images: catalog!.images.filter((image) => image.id !== id) };
          },
          { valid: () => !signal?.aborted },
        );
        signal?.throwIfAborted();
        this.#images = entityMap(result?.value?.images ?? []);
        this.#imagesError = undefined;
        if (!result?.value?.images.some((image) => image.fileName === record.fileName))
          await directory.removeEntry(record.fileName).catch(() => {});
        return null;
      } catch (error) {
        if (!signal?.aborted) this.#imagesError = error;
        throw error;
      }
    });
  }

  /**
   * Commit bytes before the catalog, then publish. A competing replacement wins if
   * it changed the record observed at call time. Only our committed blob is returned;
   * callers can readImage() after an undefined result to use the competing winner.
   */
  async saveImage(id: string, image: CachedImage, signal?: AbortSignal): Promise<Blob | undefined> {
    signal?.throwIfAborted();
    this.#requireAccount();
    const record: ImageRecord = {
      id,
      fileName: `${crypto.randomUUID()}.image`,
      type: image.type,
      size: image.blob.size,
      cachedAt: Date.now(),
      etag: image.etag,
      lastModified: image.lastModified,
    };
    const blob = new Blob([image.blob], { type: record.type });
    const expected = this.#images.get(id)?.fileName;
    return this.#runImages(async () => {
      let directory: FileSystemDirectoryHandle | undefined;
      let writable: FileSystemWritableFileStream | undefined;
      let committed = false;
      try {
        signal?.throwIfAborted();
        directory = await this.#disk?.directory();
        if (!directory) throw new Error("No account selected.");
        const handle = await directory.getFileHandle(record.fileName, { create: true });
        writable = await handle.createWritable();
        await writable.write(blob);
        signal?.throwIfAborted();
        await writable.close();
        signal?.throwIfAborted();
        const result = await this.#disk?.update(
          "images",
          parseImages,
          (catalog) => {
            if (catalog?.images.find((image) => image.id === id)?.fileName !== expected)
              return undefined;
            return {
              images: [...(catalog?.images ?? []).filter((image) => image.id !== id), record],
            };
          },
          { valid: () => !signal?.aborted },
        );
        committed = result?.written ?? false;
        // A completed catalog commit owns its bytes, even if cancellation arrived during close.
        if (committed && expected) await directory.removeEntry(expected).catch(() => {});
        signal?.throwIfAborted();
        this.#images = entityMap(result?.value?.images ?? []);
        this.#imagesError = undefined;
        return committed ? blob : undefined;
      } catch (error) {
        if (!signal?.aborted) this.#imagesError = error;
        throw error;
      } finally {
        if (!committed) {
          await writable?.abort().catch(() => {});
          await directory?.removeEntry(record.fileName).catch(() => {});
        }
      }
    });
  }

  get downloads() {
    return this.#downloads;
  }
  get downloadsError() {
    return this.#downloadsError;
  }
  get downloadsLoading() {
    return this.#downloadLoads > 0;
  }
  #hydrateDownloads(signal?: AbortSignal) {
    this.#downloadLoads++;
    return this.#loadDownloads(signal).finally(() => {
      this.#downloadLoads--;
    });
  }

  #loadDownloads(signal?: AbortSignal) {
    return this.#runDownloads(async () => {
      try {
        signal?.throwIfAborted();
        const catalog = await this.#disk?.read("downloads", parseDownloads);
        signal?.throwIfAborted();
        this.#downloads = downloadMap(catalog?.downloads ?? []);
        this.#downloadsError = undefined;
      } catch (error) {
        if (!signal?.aborted) this.#downloadsError = error;
        throw error;
      }
    });
  }

  /** Open a file lazily without copying audio into RAM or adopting unlisted bytes. */
  readDownload(
    trackId: string,
    format: DownloadFormat,
    signal?: AbortSignal,
  ): Promise<File | null> {
    return this.#runDownloads(async () => {
      try {
        signal?.throwIfAborted();
        const key = downloadKey(trackId, format);
        let record = this.#downloads.get(key);
        if (!record) return null;
        const directory = await this.#disk?.directory();
        if (!directory) return null;
        while (record) {
          signal?.throwIfAborted();
          try {
            const file = await (await directory.getFileHandle(record.fileName)).getFile();
            signal?.throwIfAborted();
            if (file.size === record.size) {
              this.#downloadsError = undefined;
              return file;
            }
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
          }
          const missing = record.fileName;
          const result = await this.#disk?.update(
            "downloads",
            parseDownloads,
            (catalog) => {
              const current = catalog?.downloads.find(
                (item) => downloadKey(item.track.id, item.format) === key,
              );
              if (current?.fileName !== missing) return undefined;
              return {
                ...catalog!,
                downloads: catalog!.downloads.filter((item) => item.fileName !== missing),
              };
            },
            { valid: () => !signal?.aborted },
          );
          signal?.throwIfAborted();
          this.#downloads = downloadMap(result?.value?.downloads ?? []);
          if (!result?.value?.downloads.some((item) => item.fileName === missing))
            await directory.removeEntry(missing).catch(() => {});
          // A stale miss may reveal a competing writer's complete replacement.
          record = this.#downloads.get(key);
        }
        this.#downloadsError = undefined;
        return null;
      } catch (error) {
        if (!signal?.aborted) this.#downloadsError = error;
        throw error;
      }
    });
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
    let directory: FileSystemDirectoryHandle | undefined;
    let writable: FileSystemWritableFileStream | undefined;
    let fileName: string | undefined;
    let committed = false;
    try {
      signal.throwIfAborted();
      const account = this.#requireAccount();
      const candidate = {
        track: structuredClone(track) as CachedDownload["track"],
        format,
        contentType,
      };
      const key = downloadKey(candidate.track.id, candidate.format);
      const lock = await hash(JSON.stringify([account.host, account.username, key]));
      const save = async () => {
        signal.throwIfAborted();
        // Always take the per-file lock before any short-lived catalog lock.
        await this.#loadDownloads(signal);
        const cached = await this.readDownload(candidate.track.id, candidate.format, signal);
        if (cached) return cached;
        const expected = this.#downloads.get(key)?.fileName;
        directory = await this.#disk?.directory();
        if (!directory) throw new Error("No account selected.");
        signal.throwIfAborted();
        fileName = `${crypto.randomUUID()}.audio`;
        const handle = await directory.getFileHandle(fileName, { create: true });
        writable = await handle.createWritable();
        if (!response.body) throw new Error("The downloaded audio response has no body.");
        await response.body.pipeTo(writable, { signal });
        signal.throwIfAborted();
        const file = await handle.getFile();
        const record: CachedDownload = {
          ...candidate,
          fileName,
          size: file.size,
          downloadedAt: Date.now(),
        };
        await this.#runDownloads(async () => {
          signal.throwIfAborted();
          const result = await this.#disk?.update(
            "downloads",
            parseDownloads,
            (catalog) => {
              const current = catalog?.downloads.find(
                (item) => downloadKey(item.track.id, item.format) === key,
              );
              if (current?.fileName !== expected) return undefined;
              return {
                downloads: [
                  ...(catalog?.downloads ?? []).filter(
                    (item) => downloadKey(item.track.id, item.format) !== key,
                  ),
                  record,
                ],
              };
            },
            { valid: () => !signal.aborted },
          );
          committed = result?.written ?? false;
          // Cancellation during atomic close must never delete committed bytes.
          signal.throwIfAborted();
          this.#downloads = downloadMap(result?.value?.downloads ?? []);
          this.#downloadsError = undefined;
        });
        if (committed) return file;
        const winner = await this.readDownload(candidate.track.id, candidate.format, signal);
        if (!winner) throw new Error("The competing download is no longer available.");
        return winner;
      };
      return await (navigator.locks
        ? navigator.locks.request(`libras-download:${lock}.audio`, { signal }, save)
        : save());
    } catch (error) {
      if (!signal.aborted && this.account) this.#downloadsError = error;
      throw error;
    } finally {
      if (!committed && fileName) {
        await writable?.abort().catch(() => {});
        await directory?.removeEntry(fileName).catch(() => {});
      }
      if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  async replaceLibrary(snapshot: Immutable<LibrarySnapshot>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#requireAccount();
    const candidate = structuredClone(snapshot) as LibrarySnapshot;
    const prepared = prepareLibrary(candidate);
    return this.#runLibrary(async () => {
      signal?.throwIfAborted();
      const result = await this.#disk?.update(
        "library",
        parseLibrary,
        (existing) => {
          if (
            existing &&
            ((existing.lastModified !== null &&
              candidate.lastModified !== null &&
              existing.lastModified > candidate.lastModified) ||
              (existing.lastModified === candidate.lastModified &&
                existing.savedAt > candidate.savedAt))
          )
            return undefined;
          return candidate;
        },
        {
          valid: () => !signal?.aborted,
          // A fresh, validated server library can repair a corrupt snapshot.
          repair: true,
        },
      );
      signal?.throwIfAborted();
      if (result?.written) this.#library = prepared;
      else if (result?.value) this.#library = prepareLibrary(result?.value);
    });
  }
}
