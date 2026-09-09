import * as v from "valibot";
import {
  accountSchema,
  artistSchema,
  albumSchema,
  trackSchema,
  type MetadataAccount,
} from "./schema";
import { OpfsJsonStore, jsonFileName } from "./json-store";

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const snapshotSchema = v.strictObject({
  account: accountSchema,
  lastModified: v.nullable(timestamp),
  savedAt: timestamp,
  artists: v.array(artistSchema),
  albums: v.array(albumSchema),
  tracks: v.array(trackSchema),
});
export type MetadataSnapshot = v.InferOutput<typeof snapshotSchema>;

export function entityMap<T extends { id: string }>(items: readonly T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`Duplicate metadata ID: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

/** Validate the same complete graph whether it came from normalization or storage. */
export function parseSnapshot(value: unknown): MetadataSnapshot {
  const snapshot = v.parse(snapshotSchema, value);
  const artists = entityMap(snapshot.artists);
  const albums = entityMap(snapshot.albums);
  entityMap(snapshot.tracks);
  for (const album of albums.values()) {
    if (!artists.has(album.artistId)) throw new Error(`Unknown artist for album ${album.id}.`);
  }
  for (const track of snapshot.tracks) {
    if (!artists.has(track.artistId) || !albums.has(track.albumId)) {
      throw new Error(`Invalid metadata references for track ${track.id}.`);
    }
  }
  return snapshot;
}

const queueRecordSchema = v.strictObject({
  account: v.strictObject({ host: v.string(), username: v.string() }),
  tracks: v.array(v.pipe(v.string(), v.minLength(1))),
  index: v.pipe(v.number(), v.integer(), v.minValue(-1)),
  position: v.pipe(v.number(), v.finite(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  pendingSync: v.boolean(),
});
export type QueueRecord = v.InferOutput<typeof queueRecordSchema>;

function parseQueueRecord(value: unknown, account: MetadataAccount) {
  const record = v.parse(queueRecordSchema, value);
  if (record.account.host !== account.host || record.account.username !== account.username)
    throw new Error("The queue belongs to a different account.");
  if (record.index >= record.tracks.length || (record.index === -1 && record.position !== 0))
    throw new Error("The saved queue selection is invalid.");
  return record;
}

/** Application-owned persistence services; acquiring account access does not perform I/O. */
export class Storage {
  #metadataFiles = new Map<string, Promise<OpfsJsonStore<MetadataSnapshot>>>();
  #queueFiles = new Map<string, Promise<OpfsJsonStore<QueueRecord>>>();

  #queueFile({ host, username }: MetadataAccount) {
    const key = `${host}\n${username}`;
    let file = this.#queueFiles.get(key);
    if (!file) {
      file = jsonFileName(key)
        .then(
          (fileName) =>
            new OpfsJsonStore({
              directory: "queue",
              fileName,
              lockName: `music-web-queue:${fileName}`,
              parse: (value) => parseQueueRecord(value, { host, username }),
            }),
        )
        .catch((error) => {
          this.#queueFiles.delete(key);
          throw error;
        });
      this.#queueFiles.set(key, file);
    }
    return file;
  }

  queue(account: MetadataAccount) {
    const identity = Object.freeze({ host: account.host, username: account.username });
    return {
      account: identity,
      read: async () => (await this.#queueFile(identity)).read(),
      save: async (record: QueueRecord) => {
        if (record.account.host !== identity.host || record.account.username !== identity.username)
          throw new Error("The queue belongs to a different account.");
        const file = await this.#queueFile(identity);
        return file.update(
          (previous) => (previous && previous.updatedAt > record.updatedAt ? undefined : record),
          // Preserve the queue's existing repair-on-write policy.
          { recoverReadError: () => null },
        );
      },
    };
  }

  #metadataFile({ host, username }: MetadataAccount) {
    const key = `${host}\n${username}`;
    let file = this.#metadataFiles.get(key);
    if (!file) {
      file = jsonFileName(key)
        .then(
          (fileName) =>
            new OpfsJsonStore({
              directory: "metadata",
              fileName,
              lockName: `music-web-metadata:${fileName}`,
              parse: (value) => {
                const snapshot = parseSnapshot(value);
                if (snapshot.account.host !== host || snapshot.account.username !== username)
                  throw new Error("The metadata snapshot belongs to a different account.");
                return snapshot;
              },
            }),
        )
        .catch((error) => {
          this.#metadataFiles.delete(key);
          throw error;
        });
      this.#metadataFiles.set(key, file);
    }
    return file;
  }

  metadata(account: MetadataAccount) {
    const identity = Object.freeze({ host: account.host, username: account.username });
    return {
      account: identity,
      read: async () => (await this.#metadataFile(identity)).read(),
      save: (snapshot: MetadataSnapshot, current?: () => boolean) =>
        this.#saveMetadata(identity, snapshot, current),
    };
  }

  async #saveMetadata(
    account: MetadataAccount,
    snapshot: MetadataSnapshot,
    current: () => boolean = () => true,
  ) {
    if (snapshot.account.host !== account.host || snapshot.account.username !== account.username)
      throw new Error("The metadata snapshot belongs to a different account.");
    const file = await this.#metadataFile(account);
    const result = await file.update(
      (existing) => {
        if (
          existing &&
          ((existing.lastModified !== null &&
            snapshot.lastModified !== null &&
            existing.lastModified > snapshot.lastModified) ||
            (existing.lastModified === snapshot.lastModified &&
              existing.savedAt > snapshot.savedAt))
        )
          return undefined;
        return snapshot;
      },
      {
        valid: current,
        // Preserve metadata's existing policy: a fresh server snapshot may repair a bad cache.
        recoverReadError: () => null,
      },
    );
    return current() ? result.value : undefined;
  }
}
