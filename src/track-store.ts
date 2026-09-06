import * as v from "valibot";

const trackSchema = v.object({
  id: v.string(),
  title: v.string(),
  artist: v.string(),
  album: v.string(),
  contentType: v.optional(v.string()),
  coverArt: v.optional(v.string()),
});
const downloadSchema = v.object({
  key: v.string(),
  fileName: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}\.audio$/)),
  host: v.string(),
  username: v.string(),
  track: trackSchema,
  format: v.picklist(["raw", "mp3"]),
  contentType: v.string(),
  size: v.pipe(v.number(), v.integer(), v.minValue(1)),
  downloadedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000)),
});
const catalogSchema = v.array(downloadSchema);
export type DownloadedFile = v.InferOutput<typeof downloadSchema>;
export type DownloadTrack = DownloadedFile["track"];
export type TrackFileDescriptor = Pick<
  DownloadedFile,
  "key" | "host" | "username" | "format" | "contentType"
>;

// Audio files keep their original hashed names. The catalog contains no credentials
// and only publishes files after their writable stream has closed successfully.
export class OpfsTrackStore {
  #index?: Map<string, DownloadedFile>;
  #loading?: Promise<Map<string, DownloadedFile>>;
  #writes: Promise<unknown> = Promise.resolve();
  #names = new Map<string, string>();

  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("tracks", { create: true });
  }

  async #fileName(key: string) {
    const existing = this.#names.get(key);
    if (existing) return existing;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const name = `${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}.audio`;
    this.#names.set(key, name);
    return name;
  }

  async #readIndex(directory: FileSystemDirectoryHandle) {
    try {
      const handle = await directory.getFileHandle("downloads.json");
      const records = v.parse(catalogSchema, JSON.parse(await (await handle.getFile()).text()));
      const index = new Map<string, DownloadedFile>();
      for (const record of records) {
        const key = `${record.host}\n${record.username}\n${record.track.id}\n${record.format}-v1`;
        if (
          record.key !== key ||
          record.fileName !== (await this.#fileName(key)) ||
          index.has(key)
        ) {
          throw new Error("The downloads catalog contains an invalid file reference.");
        }
        index.set(key, record);
      }
      return index;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return new Map<string, DownloadedFile>();
      throw error;
    }
  }

  #load() {
    if (this.#index) return Promise.resolve(this.#index);
    return (this.#loading ??= this.#directory()
      .then((directory) => this.#readIndex(directory))
      .then((index) => {
        this.#index = index;
        return index;
      })
      .finally(() => {
        this.#loading = undefined;
      }));
  }

  #mutate(change: (index: Map<string, DownloadedFile>) => void) {
    const write = async () => {
      const directory = await this.#directory();
      // Re-read under the lock so another tab's completed downloads aren't lost.
      const index = await this.#readIndex(directory);
      change(index);
      const handle = await directory.getFileHandle("downloads.json", { create: true });
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await handle.createWritable();
        await writable.write(JSON.stringify([...index.values()], null, 2));
        await writable.close();
        this.#index = index;
      } catch (error) {
        await writable?.abort().catch(() => {});
        // A failed first write must not leave an empty, unparsable catalog behind.
        const file = await handle.getFile().catch(() => null);
        if (file?.size === 0) await directory.removeEntry("downloads.json").catch(() => {});
        throw error;
      }
    };
    const result = this.#writes.then(() =>
      navigator.locks ? navigator.locks.request("music-web-downloads-index", write) : write(),
    );
    this.#writes = result.catch(() => {});
    return result;
  }

  async list() {
    const index = await this.#load();
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
    return [...this.#index!.values()];
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

  async get(descriptor: TrackFileDescriptor, track: DownloadTrack) {
    const index = await this.#load();
    const record = index.get(descriptor.key);
    const fileName = record?.fileName ?? (await this.#fileName(descriptor.key));
    const file = await this.#readFile(await this.#directory(), fileName);
    if (!file || (record && record.size !== file.size)) {
      if (record)
        await this.#mutate((latest) => {
          latest.delete(descriptor.key);
        });
      return null;
    }
    if (!record) {
      // Migrate pre-catalog downloads without downloading the audio again.
      await this.#mutate((latest) => {
        if (!latest.has(descriptor.key))
          latest.set(
            descriptor.key,
            v.parse(downloadSchema, {
              ...descriptor,
              track,
              fileName,
              size: file.size,
              downloadedAt: file.lastModified,
            }),
          );
      });
    }
    return file;
  }

  async put(
    descriptor: TrackFileDescriptor,
    track: DownloadTrack,
    response: Response,
    signal: AbortSignal,
  ) {
    await this.#load();
    const directory = await this.#directory();
    const fileName = await this.#fileName(descriptor.key);
    const handle = await directory.getFileHandle(fileName, { create: true });
    let writable: FileSystemWritableFileStream | undefined;
    let phase: "writing" | "indexing" = "writing";
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
      phase = "indexing";
      await this.#mutate((index) => {
        index.set(
          descriptor.key,
          v.parse(downloadSchema, {
            ...descriptor,
            track,
            fileName,
            size: file.size,
            downloadedAt: Date.now(),
          }),
        );
      });
      return file;
    } catch (error) {
      await writable?.abort().catch(() => {});
      // Only keep a recoverable orphan if the audio write completed successfully.
      if (phase === "writing") await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  }

  async entries() {
    await this.#writes;
    return [...(await this.#load()).values()];
  }
}
