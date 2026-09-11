import * as v from "valibot";
import { OpfsJsonStore, hashedFileName } from "./json-store";
import {
  accountSchema,
  artistSchema,
  albumSchema,
  trackSchema,
  imageSchema,
  downloadTrackSchema,
  type Account,
  type ImageRecord,
} from "./schema";

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
const libraryRecordSchema = v.strictObject({ account: accountSchema, ...librarySchema.entries });

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
const queueRecordSchema = v.pipe(
  v.strictObject({ account: accountSchema, ...queueFields, updatedAt: timestamp }),
  v.check((queue) => validSelection(queue), "Invalid queue selection."),
);

const imagesSchema = v.strictObject({ account: accountSchema, images: v.array(imageSchema) });
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
const downloadsSchema = v.strictObject({
  account: accountSchema,
  downloads: v.array(cachedDownloadSchema),
});
/** Account-local identity, also distinguishing original files from MP3 transcodes. */
export function downloadKey(trackId: string, format: DownloadFormat) {
  return JSON.stringify([trackId, format]);
}
function downloadMap(
  records: readonly CachedDownload[],
): ReadonlyMap<string, Immutable<CachedDownload>> {
  const map = new Map<string, Immutable<CachedDownload>>();
  const files = new Set<string>();
  for (const record of records) {
    const key = downloadKey(record.track.id, record.format);
    if (map.has(key) || files.has(record.fileName))
      throw new Error("Duplicate download references.");
    map.set(key, record);
    files.add(record.fileName);
  }
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

async function accountFile<T extends { account: Account }>(
  account: Readonly<Account>,
  name: "library" | "queue" | "images" | "downloads",
  parse: (value: unknown) => T,
) {
  // Tuple encoding avoids ambiguous account keys; no legacy filename support.
  const key = await hashedFileName(JSON.stringify([account.host, account.username]), ".cache");
  return new OpfsJsonStore({
    directory: ["accounts", key.slice(0, -6)],
    fileName: `${name}.json`,
    lockName: `libras-${name}:${key}`,
    parse: (value: unknown) => {
      const record = parse(value);
      if (record.account.host !== account.host || record.account.username !== account.username)
        throw new Error(`The ${name} belongs to a different account.`);
      return record;
    },
  });
}

function entityMap<T extends { readonly id: string }>(
  records: readonly T[],
): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const record of records) {
    if (map.has(record.id)) throw new Error(`Duplicate metadata ID: ${record.id}`);
    map.set(record.id, record);
  }
  return map;
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
    snapshot,
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
 * Account-scoped local data owner. Construction performs no I/O.
 * Collections and records are immutable by contract; consumers never mutate them.
 * Library state is published only after a successful read/commit. Queue edits are
 * optimistic; checkpoints acknowledge only the revision actually committed.
 */
export class Cache {
  readonly account: Readonly<Account>;
  #library = $state.raw(prepareLibrary(null));
  #file?: Promise<OpfsJsonStore<v.InferOutput<typeof libraryRecordSchema>>>;
  #operations: Promise<unknown> = Promise.resolve();
  #queue = $state.raw<Immutable<CachedQueue>>({ tracks: [], index: -1, position: 0 });
  #queueRevision = $state(0);
  #queueSavedRevision = $state(0);
  #queueError = $state.raw<unknown>();
  #queueUpdatedAt = 0;
  #queueStore?: Promise<OpfsJsonStore<v.InferOutput<typeof queueRecordSchema>>>;
  #queueOperations: Promise<unknown> = Promise.resolve();
  #queueTimer?: ReturnType<typeof setTimeout>;
  #checkpointTimer?: ReturnType<typeof setTimeout>;
  #images = $state.raw<ReadonlyMap<string, Immutable<ImageRecord>>>(new Map());
  #imagesError = $state.raw<unknown>();
  #imagesStore?: Promise<OpfsJsonStore<v.InferOutput<typeof imagesSchema>>>;
  #imageOperations: Promise<unknown> = Promise.resolve();
  #downloads = $state.raw<ReadonlyMap<string, Immutable<CachedDownload>>>(new Map());
  #downloadsError = $state.raw<unknown>();
  #downloadsStore?: Promise<OpfsJsonStore<v.InferOutput<typeof downloadsSchema>>>;
  #downloadOperations: Promise<unknown> = Promise.resolve();

  constructor(account: Account) {
    this.account = Object.freeze(v.parse(accountSchema, account));
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
    return this.#library.snapshot?.lastModified;
  }
  get savedAt() {
    return this.#library.snapshot?.savedAt;
  }

  #libraryFile() {
    return (this.#file ??= accountFile(this.account, "library", (value) => {
      const record = v.parse(libraryRecordSchema, value);
      prepareLibrary(record); // Reject duplicate IDs on disk as well as on replacement.
      return record;
    }).catch((error) => {
      this.#file = undefined;
      throw error;
    }));
  }

  #queueFile() {
    return (this.#queueStore ??= accountFile(this.account, "queue", (value) =>
      v.parse(queueRecordSchema, value),
    ).catch((error) => {
      this.#queueStore = undefined;
      throw error;
    }));
  }

  #imagesFile() {
    return (this.#imagesStore ??= accountFile(this.account, "images", (value) => {
      const catalog = v.parse(imagesSchema, value);
      entityMap(catalog.images);
      if (new Set(catalog.images.map((image) => image.fileName)).size !== catalog.images.length)
        throw new Error("Duplicate image file references.");
      return catalog;
    }).catch((error) => {
      this.#imagesStore = undefined;
      throw error;
    }));
  }

  // Serialize publication with persistence, not just file access. A pending load
  // cannot publish an older snapshot after a later replacement has completed.
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }

  /** Restore independent local domains, reporting failures after all finish. */
  async load(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const [library, queue, images, downloads] = await Promise.allSettled([
      this.#loadLibrary(signal),
      this.#loadQueue(signal),
      this.#loadImages(signal),
      this.#loadDownloads(signal),
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
    return this.#run(async () => {
      signal?.throwIfAborted();
      const record = await (await this.#libraryFile()).read();
      signal?.throwIfAborted();
      if (record) {
        const { account: _account, ...snapshot } = record;
        this.#library = prepareLibrary(snapshot);
      } else this.#library = prepareLibrary(null);
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

  #runQueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queueOperations.then(operation);
    this.#queueOperations = result.catch(() => {});
    return result;
  }

  #loadQueue(signal?: AbortSignal) {
    const revision = this.#queueRevision;
    return this.#runQueue(async () => {
      try {
        signal?.throwIfAborted();
        const record = await (await this.#queueFile()).read();
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
    const next = v.parse(queueSchema, queue);
    const updatedAt = v.parse(timestamp, Math.max(Date.now(), this.#queueUpdatedAt + 1));
    const sameTracks =
      next.tracks.length === this.#queue.tracks.length &&
      next.tracks.every((id, index) => id === this.#queue.tracks[index]);
    this.#queue = { ...next, tracks: sameTracks ? this.#queue.tracks : next.tracks };
    this.#queueUpdatedAt = updatedAt;
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
        account: this.account,
        ...this.#queue,
        tracks: [...this.#queue.tracks],
        updatedAt: this.#queueUpdatedAt,
      };
      try {
        const file = await this.#queueFile();
        const result = await file.update(
          (previous) => (previous && previous.updatedAt > record.updatedAt ? undefined : record),
          { recoverReadError: () => null },
        );
        if (!result.written)
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
    const next = v.parse(queueSchema, queue);
    const revision = this.#queueRevision;
    const updatedAt = v.parse(timestamp, Math.max(Date.now(), this.#queueUpdatedAt + 1));
    const valid = () => !signal.aborted && revision === this.#queueRevision;
    return this.#runQueue(async () => {
      if (!valid()) return false;
      try {
        const file = await this.#queueFile();
        const result = await file.update(
          (previous) =>
            previous && previous.updatedAt > updatedAt
              ? undefined
              : { account: this.account, ...next, updatedAt },
          { valid, recoverReadError: () => null },
        );
        if (!valid()) {
          // Atomic close cannot be undone. Checkpoint the still-visible local queue
          // if cancellation arrived during close, without granting upload eligibility.
          if (result.written) {
            this.#queueUpdatedAt = Math.max(this.#queueUpdatedAt, updatedAt);
            this.#queueSavedRevision = -1;
            this.#scheduleQueue();
          }
          return false;
        }
        if (!result.written)
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

  #runImages<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#imageOperations.then(operation);
    this.#imageOperations = result.catch(() => {});
    return result;
  }

  #loadImages(signal?: AbortSignal) {
    return this.#runImages(async () => {
      try {
        signal?.throwIfAborted();
        const catalog = await (await this.#imagesFile()).read();
        signal?.throwIfAborted();
        this.#images = entityMap(catalog?.images ?? []);
        this.#imagesError = undefined;
      } catch (error) {
        if (!signal?.aborted) this.#imagesError = error;
        throw error;
      }
    });
  }

  async #filesDirectory() {
    const key = await hashedFileName(
      JSON.stringify([this.account.host, this.account.username]),
      ".cache",
    );
    let directory = await navigator.storage.getDirectory();
    for (const name of ["accounts", key.slice(0, -6), "files"])
      directory = await directory.getDirectoryHandle(name, { create: true });
    return directory;
  }

  /** Load bytes on demand. Missing/incomplete files invalidate only their matching record. */
  readImage(id: string, signal?: AbortSignal): Promise<Blob | null> {
    return this.#runImages(async () => {
      try {
        signal?.throwIfAborted();
        const record = this.#images.get(id);
        if (!record) return null;
        const directory = await this.#filesDirectory();
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
        const result = await (
          await this.#imagesFile()
        ).update(
          (catalog) => {
            if (catalog?.images.find((image) => image.id === id)?.fileName !== record.fileName)
              return undefined;
            return { ...catalog!, images: catalog!.images.filter((image) => image.id !== id) };
          },
          { valid: () => !signal?.aborted },
        );
        signal?.throwIfAborted();
        this.#images = entityMap(result.value?.images ?? []);
        this.#imagesError = undefined;
        if (!result.value?.images.some((image) => image.fileName === record.fileName))
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
    const record = v.parse(imageSchema, {
      id,
      fileName: `${crypto.randomUUID()}.image`,
      type: image.type,
      size: image.blob.size,
      cachedAt: Date.now(),
      etag: image.etag,
      lastModified: image.lastModified,
    });
    const blob = new Blob([image.blob], { type: record.type });
    const expected = this.#images.get(id)?.fileName;
    return this.#runImages(async () => {
      let directory: FileSystemDirectoryHandle | undefined;
      let writable: FileSystemWritableFileStream | undefined;
      let committed = false;
      try {
        signal?.throwIfAborted();
        directory = await this.#filesDirectory();
        const handle = await directory.getFileHandle(record.fileName, { create: true });
        writable = await handle.createWritable();
        await writable.write(blob);
        signal?.throwIfAborted();
        await writable.close();
        signal?.throwIfAborted();
        const result = await (
          await this.#imagesFile()
        ).update(
          (catalog) => {
            if (catalog?.images.find((image) => image.id === id)?.fileName !== expected)
              return undefined;
            return {
              account: this.account,
              images: [...(catalog?.images ?? []).filter((image) => image.id !== id), record],
            };
          },
          { valid: () => !signal?.aborted },
        );
        committed = result.written;
        // A completed catalog commit owns its bytes, even if cancellation arrived during close.
        if (committed && expected) await directory.removeEntry(expected).catch(() => {});
        signal?.throwIfAborted();
        this.#images = entityMap(result.value?.images ?? []);
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

  #downloadsFile() {
    return (this.#downloadsStore ??= accountFile(this.account, "downloads", (value) => {
      const catalog = v.parse(downloadsSchema, value);
      downloadMap(catalog.downloads);
      return catalog;
    }).catch((error) => {
      this.#downloadsStore = undefined;
      throw error;
    }));
  }
  #runDownloads<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#downloadOperations.then(operation);
    this.#downloadOperations = result.catch(() => {});
    return result;
  }
  #loadDownloads(signal?: AbortSignal) {
    return this.#runDownloads(async () => {
      try {
        signal?.throwIfAborted();
        const catalog = await (await this.#downloadsFile()).read();
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
        const directory = await this.#filesDirectory();
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
          const result = await (
            await this.#downloadsFile()
          ).update(
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
          this.#downloads = downloadMap(result.value?.downloads ?? []);
          if (!result.value?.downloads.some((item) => item.fileName === missing))
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
      const candidate = v.parse(cachedDownloadSchema, {
        track,
        format,
        contentType,
        fileName: `${crypto.randomUUID()}.audio`,
        size: 1,
        downloadedAt: Date.now(),
      });
      const key = downloadKey(candidate.track.id, candidate.format);
      const lock = await hashedFileName(
        JSON.stringify([this.account.host, this.account.username, key]),
        ".audio",
      );
      const save = async () => {
        signal.throwIfAborted();
        // Always take the per-file lock before any short-lived catalog lock.
        await this.#loadDownloads(signal);
        const cached = await this.readDownload(candidate.track.id, candidate.format, signal);
        if (cached) return cached;
        const expected = this.#downloads.get(key)?.fileName;
        directory = await this.#filesDirectory();
        signal.throwIfAborted();
        fileName = candidate.fileName;
        const handle = await directory.getFileHandle(fileName, { create: true });
        writable = await handle.createWritable();
        if (!response.body) throw new Error("The downloaded audio response has no body.");
        await response.body.pipeTo(writable, { signal });
        signal.throwIfAborted();
        const file = await handle.getFile();
        const record = v.parse(cachedDownloadSchema, {
          ...candidate,
          size: file.size,
          downloadedAt: Date.now(),
        });
        await this.#runDownloads(async () => {
          signal.throwIfAborted();
          const result = await (
            await this.#downloadsFile()
          ).update(
            (catalog) => {
              const current = catalog?.downloads.find(
                (item) => downloadKey(item.track.id, item.format) === key,
              );
              if (current?.fileName !== expected) return undefined;
              return {
                account: this.account,
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
          committed = result.written;
          // Cancellation during atomic close must never delete committed bytes.
          signal.throwIfAborted();
          this.#downloads = downloadMap(result.value?.downloads ?? []);
          this.#downloadsError = undefined;
        });
        if (committed) return file;
        const winner = await this.readDownload(candidate.track.id, candidate.format, signal);
        if (!winner) throw new Error("The competing download is no longer available.");
        return winner;
      };
      return await (navigator.locks
        ? navigator.locks.request(`libras-download:${lock}`, { signal }, save)
        : save());
    } catch (error) {
      if (!signal.aborted) this.#downloadsError = error;
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
    // Validation also copies caller-owned records before any asynchronous work.
    const candidate = v.parse(librarySchema, snapshot);
    const prepared = prepareLibrary(candidate);
    return this.#run(async () => {
      signal?.throwIfAborted();
      const file = await this.#libraryFile();
      const result = await file.update(
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
          return { account: this.account, ...candidate };
        },
        {
          valid: () => !signal?.aborted,
          // A fresh, validated server library can repair a corrupt snapshot.
          recoverReadError: () => null,
        },
      );
      signal?.throwIfAborted();
      if (result.written) this.#library = prepared;
      else if (result.value) {
        const { account: _account, ...winner } = result.value;
        this.#library = prepareLibrary(winner);
      }
    });
  }
}
