import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, parseSnapshot, type MetadataSnapshot, type QueueRecord } from "./storage";
import { jsonFileName } from "./json-store";
import type { TrackFileDescriptor } from "./schema";

const account = { host: "https://music.example.com", username: "listener" };
const snapshot = (): MetadataSnapshot => ({
  account,
  lastModified: 10,
  savedAt: 100,
  artists: [{ id: "artist", name: "Artist", genres: [] }],
  albums: [{ id: "album", title: "Album", artistId: "artist", genres: [] }],
  tracks: [{ id: "song", title: "Song", artistId: "artist", albumId: "album", genres: [] }],
});

function installStorage() {
  const files = new Map<string, string | Blob>();
  const state = {
    writes: 0,
    fail: false,
    beforeWrite: (_path: string) => {},
    afterRead: (_path: string) => {},
    afterClose: (_path: string) => {},
  };
  const getDirectory = vi.fn(async () => ({
    async getDirectoryHandle(directory: string) {
      expect(["metadata", "queue", "images", "tracks"]).toContain(directory);
      return {
        async getFileHandle(name: string, options?: { create?: boolean }) {
          const path = `${directory}/${name}`;
          if (!files.has(path) && !options?.create)
            throw new DOMException("Missing", "NotFoundError");
          if (!files.has(path)) files.set(path, "");
          return {
            async getFile() {
              const value = files.get(path)!;
              const file = value instanceof File ? value : new File([value], name);
              state.afterRead(path);
              return file;
            },
            async createWritable() {
              let pending: string | Blob = "";
              const write = (value: string | Blob) => {
                state.beforeWrite(path);
                if (state.fail) throw new Error("Storage full");
                pending = value;
              };
              const close = () => {
                files.set(path, pending);
                state.writes++;
                state.afterClose(path);
              };
              return Object.assign(
                new WritableStream<Uint8Array>({
                  write: (chunk) => write(new Blob([pending, chunk.slice().buffer as ArrayBuffer])),
                  close,
                }),
                {
                  write: async (value: string | Blob) => write(value),
                  close: async () => close(),
                  abort: async () => {},
                },
              );
            },
          };
        },
        async removeEntry(name: string) {
          files.delete(`${directory}/${name}`);
        },
      };
    },
  }));
  const lock = vi.fn(
    async (
      _name: string,
      options: LockOptions | (() => Promise<unknown>),
      callback?: () => Promise<unknown>,
    ) => {
      if (typeof options === "function") return options();
      options.signal?.throwIfAborted();
      return callback!();
    },
  );
  vi.stubGlobal("navigator", { storage: { getDirectory }, locks: { request: lock } });
  return { files, state, getDirectory, lock };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves committed artwork when cancellation arrives during catalog close", async () => {
  const disk = installStorage();
  let valid = true;
  disk.state.afterClose = (path) => {
    if (path.endsWith(".json")) valid = false;
  };
  await expect(
    new Storage()
      .artwork(account)
      .saveImage("cover", { blob: new Blob(["image"]), type: "image/png" }, undefined, () => valid),
  ).resolves.toBeUndefined();
  const catalogPath = `images/${await jsonFileName(`${account.host}\n${account.username}`)}`;
  const catalog = JSON.parse(disk.files.get(catalogPath) as string);
  expect(disk.files.has(`images/${catalog.images[0].fileName}`)).toBe(true);
});

it.each([0, 1])(
  "preserves a replacement audio record during stale repair (timestamp delta: %s)",
  async (delta) => {
    const disk = installStorage();
    const audio = new Storage().audio();
    const descriptor: TrackFileDescriptor = {
      ...account,
      key: `${account.host}\n${account.username}\ntrack\nmp3-v1`,
      format: "mp3",
      contentType: "audio/mpeg",
    };
    const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
    await audio.save(descriptor, track, new Response("old audio"), new AbortController().signal);
    const [old] = await audio.entries();
    const newer = { ...old, downloadedAt: old.downloadedAt + delta, size: 12 };
    const path = `tracks/${old.fileName}`;
    disk.files.set(path, "x");
    disk.state.afterRead = (readPath) => {
      if (readPath === path) {
        disk.state.afterRead = () => {};
        disk.files.set(path, "new complete");
        disk.files.set("tracks/downloads.json", JSON.stringify([newer]));
      }
    };
    await audio.read(descriptor, track);
    expect(await audio.entries()).toEqual([newer]);
  },
);

describe("audio storage", () => {
  const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
  const descriptor = (identity = account): TrackFileDescriptor => ({
    ...identity,
    key: `${identity.host}\n${identity.username}\ntrack\nmp3-v1`,
    format: "mp3",
    contentType: "audio/mpeg",
  });

  it("shares a lazy cross-account catalog and streams files through the existing locks", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const first = storage.audio();
    const second = storage.audio();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await first.entries()).toEqual([]);
    const signal = new AbortController().signal;
    const own = descriptor();
    const other = descriptor({ ...account, username: "other" });
    const response = new Response("first audio");
    expect(await (await second.save(own, track, response, signal)).text()).toBe("first audio");
    expect(response.bodyUsed).toBe(true);
    await first.save(other, track, new Response("other audio"), signal);
    expect((await second.entries()).map((record) => record.key).sort()).toEqual(
      [own.key, other.key].sort(),
    );
    expect(await (await first.read(own, track))!.text()).toBe("first audio");
    expect(await (await second.read(other, track))!.text()).toBe("other audio");
    expect(await new Storage().audio().list()).toHaveLength(2);
    const name = (await jsonFileName(own.key)).replace(/\.json$/, ".audio");
    expect(disk.files.has(`tracks/${name}`)).toBe(true);
    expect(disk.files.has("tracks/downloads.json")).toBe(true);
    expect(disk.lock).toHaveBeenCalledWith(
      `music-web-audio:${name}`,
      { signal },
      expect.any(Function),
    );
    expect(disk.lock).toHaveBeenCalledWith("music-web-downloads-index", expect.any(Function));
  });

  it("adopts legacy audio without renaming files or changing their recorded modification dates", async () => {
    const disk = installStorage();
    const entry = descriptor();
    const name = (await jsonFileName(entry.key)).replace(/\.json$/, ".audio");
    disk.files.set(`tracks/${name}`, new File(["legacy"], name, { lastModified: 123 }));
    const audio = new Storage().audio();
    expect(await (await audio.read(entry, track))!.text()).toBe("legacy");
    expect(await audio.entries()).toEqual([
      expect.objectContaining({ key: entry.key, fileName: name, downloadedAt: 123, size: 6 }),
    ]);
    expect([...disk.files.keys()].sort()).toEqual(
      [`tracks/${name}`, "tracks/downloads.json"].sort(),
    );
  });
});

describe("artwork storage", () => {
  const valid = () => true;
  const image = (text = "image") => ({ blob: new Blob([text]), type: "image/png", etag: '"v1"' });

  it("stores catalogs and images together and returns independent image bytes", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const artwork = storage.artwork(account);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const empty = await artwork.read(valid);
    expect(empty?.catalog.images).toEqual([]);
    await artwork.update(
      (catalog) => ({
        ...catalog,
        metadataSavedAt: 100,
        albums: [{ id: "album", candidates: ["cover"] }],
      }),
      valid,
    );
    const saved = await artwork.saveImage("cover", image(), undefined, valid);
    expect(saved?.image?.blob.type).toBe("image/png");
    const record = saved!.catalog.images[0];
    expect(record).toMatchObject({ id: "cover", type: "image/png", size: 5, etag: '"v1"' });
    const blob = await artwork.readImage(record);
    disk.files.set(`images/${record.fileName}`, "other");
    expect(await blob.text()).toBe("image");
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    expect(disk.files.has(`images/${name}`)).toBe(true);
    expect(disk.lock).toHaveBeenCalledWith(`music-web-covers:${name}`, expect.any(Function));
    expect((await artwork.read(valid))?.catalog.albums).toEqual([
      { id: "album", candidates: ["cover"] },
    ]);
    expect(
      (await storage.artwork({ ...account, username: "other" }).read(valid))?.catalog.images,
    ).toEqual([]);
  });

  it("filters missing and truncated files even when persisting repairs fails", async () => {
    const disk = installStorage();
    const artwork = new Storage().artwork(account);
    await artwork.update(
      (catalog) => ({
        ...catalog,
        albums: [{ id: "album", candidates: ["a", "b"] }],
        images: ["a", "b"].map((id) => ({
          id,
          fileName: `${id}.image`,
          type: "image/png",
          size: 5,
          cachedAt: 100,
        })),
      }),
      valid,
    );
    disk.files.set("images/b.image", "x");
    disk.state.fail = true;
    const result = await artwork.read(valid);
    expect(result?.catalog.images).toEqual([]);
    expect(result?.catalog.albums[0].candidates).toEqual(["a", "b"]);
    expect(result?.error).toBeInstanceOf(Error);
    disk.state.fail = false;
    const repaired = await artwork.read(valid);
    expect(repaired?.error).toBeUndefined();
    expect(repaired?.catalog.images).toEqual([]);
    expect(disk.files.get("images/b.image")).toBe("x");
  });

  it("keeps the concurrent winner and removes only the unused image file", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const first = storage.artwork(account);
    const second = storage.artwork({ ...account });
    const results = await Promise.all([
      first.saveImage("cover", image("first"), undefined, valid),
      second.saveImage("cover", image("second"), undefined, valid),
    ]);
    expect(results.filter((result) => result?.image)).toHaveLength(1);
    expect([...disk.files.keys()].filter((name) => name.endsWith(".image"))).toHaveLength(1);
    const read = await first.read(valid);
    expect(read?.catalog.images).toHaveLength(1);
    const winner = results.find((result) => result?.image)!;
    expect(await (await second.readImage(read!.catalog.images[0])).text()).toBe(
      await winner.image!.blob.text(),
    );
  });

  it("preserves cached bytes and catalog after failed or cancelled replacements", async () => {
    const disk = installStorage();
    const artwork = new Storage().artwork(account);
    const original = await artwork.saveImage("cover", image(), undefined, valid);
    const previous = original!.catalog.images[0];
    disk.state.beforeWrite = (path) => {
      if (path.endsWith(".json")) throw new Error("Storage full");
    };
    await expect(
      artwork.saveImage("cover", image("new"), previous.fileName, valid),
    ).rejects.toThrow("Storage full");
    let current = true;
    disk.state.beforeWrite = (path) => {
      if (path.endsWith(".json")) current = false;
    };
    expect(
      await artwork.saveImage("cover", image("late"), previous.fileName, () => current),
    ).toBeUndefined();
    disk.state.beforeWrite = () => {};
    expect((await artwork.read(valid))?.catalog).toEqual(original!.catalog);
    expect(await (await artwork.readImage(previous)).text()).toBe("image");
    expect([...disk.files.keys()].filter((name) => name.endsWith(".image"))).toEqual([
      `images/${previous.fileName}`,
    ]);
  });

  it("does not repair corrupt catalogs or adopt legacy images implicitly", async () => {
    const disk = installStorage();
    const artwork = new Storage().artwork(account);
    const path = `images/${await jsonFileName(`${account.host}\n${account.username}`)}`;
    disk.files.set(path, "broken JSON");
    disk.files.set("images/legacy.image", "legacy");
    await expect(artwork.read(valid)).rejects.toThrow();
    await expect(artwork.update((catalog) => catalog, valid)).rejects.toThrow();
    await expect(artwork.saveImage("cover", image(), undefined, valid)).rejects.toThrow();
    expect(disk.files.get(path)).toBe("broken JSON");
    expect([...disk.files.keys()]).toEqual([path, "images/legacy.image"]);
  });
});

describe("queue storage", () => {
  const record = (): QueueRecord => ({
    account,
    tracks: ["a", "b", "a"],
    index: 2,
    position: 12.5,
    updatedAt: 42,
    pendingSync: true,
  });

  it("shares Storage with metadata without sharing files or changing queue format", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const queue = storage.queue(account);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await queue.read()).toBeNull();
    expect(await queue.save(record())).toEqual({ written: true, value: record() });
    await storage.metadata(account).save(snapshot());
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    expect(disk.files.size).toBe(2);
    expect(JSON.parse(disk.files.get(`queue/${name}`) as string)).toEqual(record());
    expect(disk.lock).toHaveBeenCalledWith(`music-web-queue:${name}`, expect.any(Function));
    expect(await new Storage().queue(account).read()).toEqual(record());
    expect(await storage.metadata(account).read()).toEqual(snapshot());
  });

  it("serializes shared handles, reports conflicts, and permits equal-timestamp sync acknowledgements", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const first = storage.queue(account);
    const second = storage.queue({ ...account });
    const newer = { ...record(), updatedAt: 100 };
    expect(await Promise.all([first.save(newer), second.save(record())])).toEqual([
      { written: true, value: newer },
      { written: false, value: newer },
    ]);
    expect(disk.state.writes).toBe(1);
    const synced = { ...newer, pendingSync: false };
    expect(await second.save(synced)).toEqual({ written: true, value: synced });
    expect(await first.read()).toEqual(synced);
  });

  it("captures account identity and rejects foreign writes before I/O", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const identity = { ...account };
    const queue = storage.queue(identity);
    identity.username = "other";
    await expect(queue.save({ ...record(), account: identity })).rejects.toThrow(
      "different account",
    );
    expect(disk.getDirectory).not.toHaveBeenCalled();
    await queue.save(record());
    expect(await storage.queue(identity).read()).toBeNull();
    expect(await queue.read()).toEqual(record());
  });

  it("does not hide corrupt or foreign reads and retains explicit repair on write", async () => {
    const disk = installStorage();
    const queue = new Storage().queue(account);
    const path = `queue/${await jsonFileName(`${account.host}\n${account.username}`)}`;
    for (const invalid of [
      "broken JSON",
      JSON.stringify({ ...record(), account: { ...account, username: "other" } }),
    ]) {
      disk.files.set(path, invalid);
      await expect(queue.read()).rejects.toThrow();
      expect(disk.files.get(path)).toBe(invalid);
      await queue.save(record());
      expect(await queue.read()).toEqual(record());
    }
  });

  it.each([{ index: 3 }, { index: -1, position: 2 }, { position: -1 }])(
    "rejects invalid selection %j without replacing the saved queue",
    async (invalid) => {
      installStorage();
      const queue = new Storage().queue(account);
      await queue.save(record());
      await expect(queue.save({ ...record(), ...invalid })).rejects.toThrow();
      expect(await queue.read()).toEqual(record());
    },
  );

  it("preserves the complete queue on write failure and allows later writes", async () => {
    const disk = installStorage();
    const queue = new Storage().queue(account);
    await queue.save(record());
    const empty = { ...record(), tracks: [], index: -1, position: 0, updatedAt: 100 };
    disk.state.fail = true;
    await expect(queue.save(empty)).rejects.toThrow("Storage full");
    expect(await queue.read()).toEqual(record());
    disk.state.fail = false;
    expect(await queue.save(empty)).toEqual({ written: true, value: empty });
    expect(await queue.read()).toEqual(empty);
  });
});

describe("metadata storage", () => {
  it("is lazy and retains existing account paths, lock names, and snapshot format", async () => {
    const disk = installStorage();
    const store = new Storage();
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await store.metadata(account).read()).toBeNull();
    expect(await store.metadata(account).save(snapshot())).toEqual(snapshot());
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    expect(JSON.parse(disk.files.get(`metadata/${name}`) as string)).toEqual(snapshot());
    expect(disk.lock).toHaveBeenCalledWith(`music-web-metadata:${name}`, expect.any(Function));
    expect(await new Storage().metadata(account).read()).toEqual(snapshot());
    expect(await store.metadata({ ...account, username: "other" }).read()).toBeNull();
  });

  it("shares write ordering across metadata handles from the same Storage instance", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const first = storage.metadata(account);
    const second = storage.metadata({ ...account });
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const newer = { ...snapshot(), savedAt: 200 };
    expect(await Promise.all([first.save(newer), second.save(snapshot())])).toEqual([newer, newer]);
    expect(disk.state.writes).toBe(1);
    expect(await second.read()).toEqual(newer);
  });

  it("captures account identity and rejects writes for another account before I/O", async () => {
    const disk = installStorage();
    const storage = new Storage();
    const identity = { ...account };
    const metadata = storage.metadata(identity);
    identity.username = "other";
    expect(metadata.account).toEqual(account);
    expect(Object.isFrozen(metadata.account)).toBe(true);
    await expect(metadata.save({ ...snapshot(), account: identity })).rejects.toThrow(
      "different account",
    );
    expect(disk.getDirectory).not.toHaveBeenCalled();
    await metadata.save(snapshot());
    expect(await storage.metadata(identity).read()).toBeNull();
    expect(await metadata.read()).toEqual(snapshot());
  });

  it.each([
    [
      { lastModified: 20, savedAt: 50 },
      { lastModified: 10, savedAt: 100 },
    ],
    [
      { lastModified: 10, savedAt: 200 },
      { lastModified: 10, savedAt: 100 },
    ],
    [
      { lastModified: null, savedAt: 200 },
      { lastModified: null, savedAt: 100 },
    ],
  ])(
    "returns the newer stored snapshot instead of acknowledging an overwrite",
    async (previous, next) => {
      const disk = installStorage();
      const store = new Storage();
      const winner = { ...snapshot(), ...previous };
      await store.metadata(account).save(winner);
      expect(await store.metadata(account).save({ ...snapshot(), ...next })).toEqual(winner);
      expect(disk.state.writes).toBe(1);
      expect(await store.metadata(account).read()).toEqual(winner);
    },
  );

  it("keeps the last complete snapshot after cancellation or write failure", async () => {
    const disk = installStorage();
    const store = new Storage();
    await store.metadata(account).save(snapshot());
    const next = { ...snapshot(), savedAt: 200 };
    let valid = true;
    disk.state.beforeWrite = () => {
      valid = false;
    };
    expect(await store.metadata(account).save(next, () => valid)).toBeUndefined();
    expect(await store.metadata(account).read()).toEqual(snapshot());
    disk.state.beforeWrite = () => {};
    disk.state.fail = true;
    await expect(store.metadata(account).save(next)).rejects.toThrow("Storage full");
    expect(await store.metadata(account).read()).toEqual(snapshot());
    expect(disk.state.writes).toBe(1);
  });

  it("preserves corrupt and foreign records on read but allows explicit repair on save", async () => {
    const disk = installStorage();
    const store = new Storage();
    const name = await jsonFileName(`${account.host}\n${account.username}`);
    disk.files.set(`metadata/${name}`, "broken JSON");
    await expect(store.metadata(account).read()).rejects.toThrow();
    expect(disk.files.get(`metadata/${name}`)).toBe("broken JSON");
    await store.metadata(account).save(snapshot());
    const foreign = JSON.stringify({ ...snapshot(), account: { ...account, username: "other" } });
    disk.files.set(`metadata/${name}`, foreign);
    await expect(store.metadata(account).read()).rejects.toThrow("different account");
    expect(disk.files.get(`metadata/${name}`)).toBe(foreign);
    await store.metadata(account).save(snapshot());
    expect(await store.metadata(account).read()).toEqual(snapshot());
  });

  it("shares complete graph validation between prepared and persisted snapshots", async () => {
    const disk = installStorage();
    const store = new Storage();
    const invalid = { ...snapshot(), artists: [] };
    expect(() => parseSnapshot(invalid)).toThrow("Unknown artist");
    await expect(store.metadata(account).save(invalid)).rejects.toThrow("Unknown artist");
    expect(disk.files.size).toBe(0);
    const duplicate = snapshot();
    duplicate.tracks.push(duplicate.tracks[0]);
    expect(() => parseSnapshot(duplicate)).toThrow("Duplicate metadata ID");
  });
});
