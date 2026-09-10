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
 * Library state is published with one assignment, only after a successful read/commit.
 */
export class Cache {
  readonly account: Readonly<Account>;
  #library = $state.raw(prepareLibrary(null));
  #file?: Promise<OpfsJsonStore<v.InferOutput<typeof libraryRecordSchema>>>;
  #operations: Promise<unknown> = Promise.resolve();

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
    return (this.#file ??= (async () => {
      // Tuple encoding avoids ambiguous account keys; no legacy filename support.
      const name = await hashedFileName(
        JSON.stringify([this.account.host, this.account.username]),
        ".cache",
      );
      return new OpfsJsonStore({
        directory: ["accounts", name.slice(0, -6)],
        fileName: "library.json",
        lockName: `libras-library:${name}`,
        parse: (value: unknown) => {
          const record = v.parse(libraryRecordSchema, value);
          if (
            record.account.host !== this.account.host ||
            record.account.username !== this.account.username
          )
            throw new Error("The library belongs to a different account.");
          // Reject duplicate IDs on disk as well as on replacement.
          prepareLibrary(record);
          return record;
        },
      });
    })().catch((error) => {
      this.#file = undefined;
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

  /** Restore this account's local data without network access. */
  load(signal?: AbortSignal): Promise<void> {
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
