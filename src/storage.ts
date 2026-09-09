import * as v from "valibot";
import {
  accountSchema,
  artistSchema,
  albumSchema,
  trackSchema,
  imageSchema,
  type ImageRecord,
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

const artworkId = v.pipe(v.string(), v.minLength(1));
const artworkTime = v.pipe(v.number(), v.integer(), v.minValue(0));
const artworkReference = v.strictObject({ id: artworkId, candidates: v.array(artworkId) });
const artworkCatalogSchema = v.strictObject({
  account: accountSchema,
  metadataSavedAt: v.nullable(artworkTime),
  artists: v.array(artworkReference),
  albums: v.array(artworkReference),
  tracks: v.array(artworkReference),
  images: v.array(imageSchema),
});
export type ArtworkCatalog = v.InferOutput<typeof artworkCatalogSchema>;
type ArtworkImage = { blob: Blob; type: string; etag?: string; lastModified?: string };

function emptyArtworkCatalog(account: MetadataAccount): ArtworkCatalog {
  return {
    account: { ...account },
    metadataSavedAt: null,
    artists: [],
    albums: [],
    tracks: [],
    images: [],
  };
}
function parseArtworkCatalog(value: unknown, account: MetadataAccount) {
  const catalog = v.parse(artworkCatalogSchema, value);
  if (catalog.account.host !== account.host || catalog.account.username !== account.username)
    throw new Error("The cover catalog belongs to a different account.");
  for (const records of [catalog.artists, catalog.albums, catalog.tracks, catalog.images]) {
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new Error("Duplicate IDs in the cover catalog.");
  }
  return catalog;
}

/** Application-owned persistence services; acquiring account access does not perform I/O. */
export class Storage {
  #metadataFiles = new Map<string, Promise<OpfsJsonStore<MetadataSnapshot>>>();
  #queueFiles = new Map<string, Promise<OpfsJsonStore<QueueRecord>>>();
  #artworkFiles = new Map<string, Promise<OpfsJsonStore<ArtworkCatalog>>>();

  async #imageDirectory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("images", { create: true });
  }

  #artworkFile({ host, username }: MetadataAccount) {
    const key = `${host}\n${username}`;
    let file = this.#artworkFiles.get(key);
    if (!file) {
      file = jsonFileName(key)
        .then(
          (fileName) =>
            new OpfsJsonStore({
              directory: "images",
              fileName,
              lockName: `music-web-covers:${fileName}`,
              parse: (value) => parseArtworkCatalog(value, { host, username }),
            }),
        )
        .catch((error) => {
          this.#artworkFiles.delete(key);
          throw error;
        });
      this.#artworkFiles.set(key, file);
    }
    return file;
  }

  async #updateArtwork(
    account: MetadataAccount,
    change: (catalog: ArtworkCatalog) => ArtworkCatalog,
    valid: () => boolean,
  ) {
    const file = await this.#artworkFile(account);
    const result = await file.update((catalog) => change(catalog ?? emptyArtworkCatalog(account)), {
      valid,
    });
    return valid() ? (result.value ?? undefined) : undefined;
  }

  artwork(account: MetadataAccount) {
    const identity = Object.freeze({ host: account.host, username: account.username });
    return {
      account: identity,
      read: (valid: () => boolean) => this.#readArtwork(identity, valid),
      update: (change: (catalog: ArtworkCatalog) => ArtworkCatalog, valid: () => boolean) =>
        this.#updateArtwork(identity, change, valid),
      readImage: async (record: ImageRecord) => {
        const directory = await this.#imageDirectory();
        const file = await (await directory.getFileHandle(record.fileName)).getFile();
        if (file.size !== record.size)
          throw new DOMException("The cached image is incomplete.", "DataError");
        // Do not expose mutable OPFS-backed files to browser image consumers.
        return new Blob([await file.arrayBuffer()], { type: record.type });
      },
      saveImage: (
        id: string,
        image: ArtworkImage,
        previousFileName: string | undefined,
        valid: () => boolean,
      ) => this.#saveArtworkImage(identity, id, image, previousFileName, valid),
    };
  }

  async #readArtwork(account: MetadataAccount, valid: () => boolean) {
    let catalog = (await (await this.#artworkFile(account)).read()) ?? emptyArtworkCatalog(account);
    const directory = await this.#imageDirectory();
    const missing = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < catalog.images.length && valid()) {
        const record = catalog.images[next++];
        try {
          const file = await (await directory.getFileHandle(record.fileName)).getFile();
          if (file.size !== record.size) missing.add(record.fileName);
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
          missing.add(record.fileName);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, catalog.images.length) }, worker));
    if (!valid()) return;
    let error: unknown;
    if (missing.size) {
      catalog = {
        ...catalog,
        images: catalog.images.filter((image) => !missing.has(image.fileName)),
      };
      try {
        catalog =
          (await this.#updateArtwork(
            account,
            (latest) => ({
              ...latest,
              images: latest.images.filter((image) => !missing.has(image.fileName)),
            }),
            valid,
          )) ?? catalog;
      } catch (cause) {
        // Still return the filtered catalog when persisting repairs fails.
        error = cause;
      }
    }
    return valid() ? { catalog, error } : undefined;
  }

  async #saveArtworkImage(
    account: MetadataAccount,
    id: string,
    image: ArtworkImage,
    previousFileName: string | undefined,
    valid: () => boolean,
  ) {
    const { blob } = image;
    const record = v.parse(imageSchema, {
      id,
      fileName: `${crypto.randomUUID()}.image`,
      type: image.type,
      size: blob.size,
      cachedAt: Date.now(),
      etag: image.etag,
      lastModified: image.lastModified,
    });
    if (!valid()) return;
    const directory = await this.#imageDirectory();
    const handle = await directory.getFileHandle(record.fileName, { create: true });
    let writable: FileSystemWritableFileStream | undefined;
    let committed = false;
    try {
      writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      const catalog = await this.#updateArtwork(
        account,
        (latest) => {
          const current = latest.images.find((image) => image.id === id);
          if (current && current.fileName !== previousFileName) return latest;
          return {
            ...latest,
            images: [...latest.images.filter((image) => image.id !== id), record],
          };
        },
        valid,
      );
      committed = catalog?.images.some((image) => image.fileName === record.fileName) ?? false;
      if (catalog && valid())
        return {
          catalog,
          image: committed ? { id, blob: new Blob([blob], { type: record.type }) } : undefined,
        };
    } finally {
      if (!committed) {
        await writable?.abort().catch(() => {});
        await directory.removeEntry(record.fileName).catch(() => {});
      }
    }
  }

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
