import * as v from "valibot";
import { OpfsJsonStore, hashedFileName } from "./json-store";
import { accountSchema, artistSchema, albumSchema, trackSchema, type Account } from "./schema";

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

/** Loading one local domain never prevents another from restoring. */
export class CacheLoadError extends AggregateError {
  constructor(readonly failures: { library?: unknown; queue?: unknown }) {
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
  name: "library" | "queue",
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
  return { snapshot, artists, albums, tracks, artistAlbums, albumTracks };
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

  // Serialize publication with persistence, not just file access. A pending load
  // cannot publish an older snapshot after a later replacement has completed.
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }

  /** Restore independent local domains, reporting failures after both finish. */
  async load(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const [library, queue] = await Promise.allSettled([
      this.#loadLibrary(signal),
      this.#loadQueue(signal),
    ]);
    signal?.throwIfAborted();
    if (library.status === "rejected" || queue.status === "rejected")
      throw new CacheLoadError({
        ...(library.status === "rejected" ? { library: library.reason } : {}),
        ...(queue.status === "rejected" ? { queue: queue.reason } : {}),
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
