interface JsonStoreOptions<T> {
  directory: string | readonly string[];
  fileName: string;
  lockName: string;
  parse: (value: unknown) => T | Promise<T>;
}
interface JsonUpdateOptions<T> {
  valid?: () => boolean;
  // Recovery is an explicit write policy, never used by read().
  recoverReadError?: (error: unknown) => T | null;
}

export async function hashedFileName(key: string, extension: `.${string}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hash}${extension}`;
}

// One instance owns one file. Values are validated JSON records, not runtime indexes.
export class OpfsJsonStore<T> {
  #options: JsonStoreOptions<T>;
  #operations: Promise<unknown> = Promise.resolve();

  constructor(options: JsonStoreOptions<T>) {
    this.#options = { ...options };
  }

  #run<R>(operation: (directory: FileSystemDirectoryHandle) => Promise<R>): Promise<R> {
    const run = async () => {
      const root = await navigator.storage.getDirectory();
      const path = this.#options.directory;
      let directory = root;
      for (const name of typeof path === "string" ? [path] : path)
        directory = await directory.getDirectoryHandle(name, { create: true });
      return operation(directory);
    };
    const result = this.#operations.then(() =>
      navigator.locks ? navigator.locks.request(this.#options.lockName, run) : run(),
    );
    // Reject the caller's promise, but don't poison subsequent operations.
    this.#operations = result.catch(() => {});
    return result;
  }

  async #read(directory: FileSystemDirectoryHandle): Promise<T | null> {
    let file: File;
    try {
      file = await (await directory.getFileHandle(this.#options.fileName)).getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
    return this.#options.parse(JSON.parse(await file.text()));
  }

  read(): Promise<T | null> {
    return this.#run((directory) => this.#read(directory));
  }

  update(
    change: (existing: T | null) => T | undefined,
    options: JsonUpdateOptions<T> = {},
  ): Promise<{ written: boolean; value: T | null }> {
    return this.#run(async (directory) => {
      const existing = await this.#read(directory).catch((error) => {
        if (!options.recoverReadError) throw error;
        return options.recoverReadError(error);
      });
      const skipped = { written: false, value: existing };
      if (options.valid && !options.valid()) return skipped;
      const value = change(existing);
      if (value === undefined) return skipped;
      if (options.valid && !options.valid()) return skipped;
      const handle = await directory.getFileHandle(this.#options.fileName, { create: true });
      let writable: FileSystemWritableFileStream | undefined;
      let committed = false;
      try {
        writable = await handle.createWritable();
        await writable.write(JSON.stringify(value));
        if (options.valid && !options.valid()) return skipped;
        // OPFS publishes the replacement on close, not on write.
        await writable.close();
        committed = true;
        return { written: true, value };
      } finally {
        if (!committed) {
          await writable?.abort().catch(() => {});
          const file = await handle.getFile().catch(() => null);
          if (file?.size === 0) await directory.removeEntry(this.#options.fileName).catch(() => {});
        }
      }
    });
  }
}
