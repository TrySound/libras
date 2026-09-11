import * as v from "valibot";
import {
  downloadSchema,
  type DownloadedFile,
  type DownloadTrack,
  type TrackFileDescriptor,
  type Account,
} from "./schema";
import { OpfsJsonStore, hashedFileName } from "./json-store";

const audioCatalogSchema = v.array(downloadSchema);

export type AudioStorage = Pick<AudioStore, "read" | "save" | "list" | "entries">;

// Audio files keep their original hashed names. The catalog contains no credentials
// and only publishes files after their writable stream has closed successfully.
class AudioStore {
  #account: Readonly<Account>;
  #index?: Map<string, DownloadedFile>;
  #loading?: Promise<Map<string, DownloadedFile>>;
  #writes: Promise<unknown> = Promise.resolve();
  #names = new Map<string, string>();
  #catalog = new OpfsJsonStore({
    directory: "tracks",
    fileName: "downloads.json",
    lockName: "music-web-downloads-index",
    parse: async (value) => {
      const records = v.parse(audioCatalogSchema, value);
      const keys = new Set<string>();
      for (const record of records) {
        const key = `${record.host}\n${record.username}\n${record.track.id}\n${record.format}-v1`;
        if (record.key !== key || record.fileName !== (await this.#fileName(key)) || keys.has(key))
          throw new Error("The downloads catalog contains an invalid file reference.");
        keys.add(key);
      }
      return records;
    },
  });

  constructor(account: Readonly<Account>) {
    this.#account = account;
  }

  #check(descriptor: TrackFileDescriptor, track: DownloadTrack) {
    if (descriptor.host !== this.#account.host || descriptor.username !== this.#account.username)
      throw new Error("The audio descriptor belongs to a different account.");
    const key = `${descriptor.host}\n${descriptor.username}\n${track.id}\n${descriptor.format}-v1`;
    if (descriptor.key !== key) throw new Error("The audio descriptor key is invalid.");
  }

  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("tracks", { create: true });
  }

  async #fileName(key: string) {
    const existing = this.#names.get(key);
    if (existing) return existing;
    const name = await hashedFileName(key, ".audio");
    this.#names.set(key, name);
    return name;
  }

  #load() {
    if (this.#index) return Promise.resolve(this.#index);
    return (this.#loading ??= this.#catalog
      .read()
      .then((records) => {
        this.#index = new Map(records?.map((record) => [record.key, record]));
        return this.#index;
      })
      .finally(() => {
        this.#loading = undefined;
      }));
  }

  #mutate(change: (index: Map<string, DownloadedFile>) => void) {
    const result = this.#catalog
      .update((records) => {
        const index = new Map(records?.map((record) => [record.key, record]));
        change(index);
        return [...index.values()];
      })
      .then(({ value }) => {
        if (!value) throw new Error("The downloads catalog update returned no value.");
        this.#index = new Map(value.map((record) => [record.key, record]));
      });
    this.#writes = result.catch(() => {});
    return result;
  }

  async list() {
    // A configured Storage instance may have been idle while another account or
    // tab updated the shared catalog. Validation always starts from disk.
    await this.#writes;
    const records = await this.#catalog.read();
    const index = new Map(records?.map((record) => [record.key, record]));
    this.#index = index;
    const directory = await this.#directory();
    const missing: DownloadedFile[] = [];
    for (const record of index.values()) {
      const file = await this.#readFile(directory, record.fileName);
      if (!file || file.size !== record.size) missing.push(record);
    }
    if (missing.length)
      await this.#mutate((latest) => {
        for (const record of missing) {
          if (latest.get(record.key)?.downloadedAt === record.downloadedAt)
            latest.delete(record.key);
        }
      });
    return [...(this.#index ?? index).values()];
  }

  async #readFile(directory: FileSystemDirectoryHandle, name: string) {
    try {
      const file = await (await directory.getFileHandle(name)).getFile();
      return file.size ? file : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async read(descriptor: TrackFileDescriptor, track: DownloadTrack) {
    this.#check(descriptor, track);
    const index = await this.#load();
    const record = index.get(descriptor.key);
    const fileName = record?.fileName ?? (await this.#fileName(descriptor.key));
    const file = await this.#readFile(await this.#directory(), fileName);
    if (!file || (record && record.size !== file.size)) {
      if (record)
        await this.#mutate((latest) => {
          const current = latest.get(descriptor.key);
          if (current?.downloadedAt === record.downloadedAt && current.size === record.size)
            latest.delete(descriptor.key);
        });
      return null;
    }
    if (!record) {
      // Migrate pre-catalog downloads without downloading the audio again.
      await this.#mutate((latest) => {
        if (!latest.has(descriptor.key)) {
          const record: DownloadedFile = {
            ...descriptor,
            track,
            fileName,
            size: file.size,
            downloadedAt: file.lastModified,
          };
          latest.set(descriptor.key, record);
        }
      });
    }
    return file;
  }

  async save(
    descriptor: TrackFileDescriptor,
    track: DownloadTrack,
    response: Response,
    signal: AbortSignal,
  ) {
    try {
      this.#check(descriptor, track);
      const fileName = await this.#fileName(descriptor.key);
      const write = async () => {
        signal.throwIfAborted();
        // A different tab may have completed this file after our initial cache miss.
        // Always acquire the audio lock before the short-lived catalog lock.
        const records = await this.#catalog.read();
        this.#index = new Map(records?.map((record) => [record.key, record]));
        const directory = await this.#directory();
        const record = this.#index.get(descriptor.key);
        const cached = record ? await this.#readFile(directory, fileName) : null;
        signal.throwIfAborted();
        if (cached && record && cached.size === record.size) return cached;
        const handle = await directory.getFileHandle(fileName, { create: true });
        let writable: FileSystemWritableFileStream | undefined;
        try {
          writable = await handle.createWritable();
          if (response.body) await response.body.pipeTo(writable, { signal });
          else {
            signal.throwIfAborted();
            await writable.write(await response.blob());
            await writable.close();
          }
          const file = await handle.getFile();
          if (!file.size) throw new Error("The downloaded audio file is empty.");
          await this.#mutate((index) => {
            const record: DownloadedFile = {
              ...descriptor,
              track,
              fileName,
              size: file.size,
              downloadedAt: Date.now(),
            };
            index.set(descriptor.key, record);
          });
          return file;
        } catch (error) {
          await writable?.abort().catch(() => {});
          // An aborted atomic write leaves old bytes intact. Never delete nonempty
          // files, including a complete orphan whose catalog commit failed.
          const file = await handle.getFile().catch(() => null);
          // Without a cross-tab lock even deleting an empty placeholder can race a close.
          if (navigator.locks && file?.size === 0)
            await directory.removeEntry(fileName).catch(() => {});
          throw error;
        }
      };
      return await (navigator.locks
        ? navigator.locks.request(`music-web-audio:${fileName}`, { signal }, write)
        : write());
    } finally {
      // Reusing a winner or cancelling a lock waiter must release its unused response.
      if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  async entries() {
    await this.#writes;
    return [...(await this.#load()).values()];
  }
}

/** Account-configured persistence capabilities; construction performs no I/O. */
export class Storage {
  readonly account: Readonly<Account>;
  readonly audio: AudioStorage;

  constructor(account: Account) {
    this.account = Object.freeze({ ...account });
    this.audio = new AudioStore(this.account);
  }
}
