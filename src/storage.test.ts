import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "./storage";
import { hashedFileName } from "./json-store";
import type { TrackFileDescriptor } from "./schema";

const account = { host: "https://music.example.com", username: "listener" };
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
      expect(["images", "tracks"]).toContain(directory);
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

describe("configured storage", () => {
  it("binds domain utilities to one immutable account without performing I/O", async () => {
    const disk = installStorage();
    const storage = new Storage(account);

    expect(storage.account).toEqual(account);
    expect(Object.isFrozen(storage.account)).toBe(true);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect((await storage.artwork.read()).account).toEqual(account);
  });

  it("copies its typed account before freezing it", () => {
    const input = { ...account };
    const storage = new Storage(input);
    input.username = "other";
    expect(storage.account).toEqual(account);
  });
});

it("preserves committed artwork when cancellation arrives during catalog close", async () => {
  const disk = installStorage();
  let valid = true;
  disk.state.afterClose = (path) => {
    if (path.endsWith(".json")) valid = false;
  };
  await expect(
    new Storage(account).artwork.saveImage(
      "cover",
      { blob: new Blob(["image"]), type: "image/png" },
      undefined,
      () => valid,
    ),
  ).resolves.toBeUndefined();
  const catalogPath = `images/${await hashedFileName(`${account.host}\n${account.username}`, ".json")}`;
  const catalog = JSON.parse(disk.files.get(catalogPath) as string);
  expect(disk.files.has(`images/${catalog.images[0].fileName}`)).toBe(true);
});

it.each([0, 1])(
  "preserves a replacement audio record during stale repair (timestamp delta: %s)",
  async (delta) => {
    const disk = installStorage();
    const audio = new Storage(account).audio;
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

  it("reads old download records while discarding unused artwork metadata", async () => {
    const disk = installStorage();
    const audio = new Storage(account).audio;
    await audio.save(descriptor(), track, new Response("audio"), new AbortController().signal);
    const records = await audio.entries();
    disk.files.set(
      "tracks/downloads.json",
      JSON.stringify(
        records.map((record) => ({
          ...record,
          track: { ...record.track, coverArt: "legacy-cover" },
        })),
      ),
    );
    const restored = await new Storage(account).audio.list();
    expect(restored).toEqual(records);
    expect(restored[0].track).not.toHaveProperty("coverArt");
  });

  it("refreshes a configured instance after another workspace updates the shared catalog", async () => {
    installStorage();
    const first = new Storage(account).audio;
    const second = new Storage({ ...account, username: "other" }).audio;
    const saved = descriptor({ ...account, username: "other" });

    expect(await first.list()).toEqual([]);
    await second.save(saved, track, new Response("audio"), new AbortController().signal);
    expect(await first.list()).toEqual([expect.objectContaining({ key: saved.key })]);
  });

  it("shares a lazy cross-account catalog and streams files through the existing locks", async () => {
    const disk = installStorage();
    const storage = new Storage(account);
    const first = storage.audio;
    const second = storage.audio;
    expect(first).toBe(second);
    expect(disk.getDirectory).not.toHaveBeenCalled();
    expect(await first.entries()).toEqual([]);
    const signal = new AbortController().signal;
    const own = descriptor();
    const otherAccount = { ...account, username: "other" };
    const other = descriptor(otherAccount);
    const otherAudio = new Storage(otherAccount).audio;
    const response = new Response("first audio");
    expect(await (await second.save(own, track, response, signal)).text()).toBe("first audio");
    expect(response.bodyUsed).toBe(true);
    await otherAudio.save(other, track, new Response("other audio"), signal);
    expect((await second.list()).map((record) => record.key).sort()).toEqual(
      [own.key, other.key].sort(),
    );
    expect(await (await first.read(own, track))!.text()).toBe("first audio");
    expect(await (await otherAudio.read(other, track))!.text()).toBe("other audio");
    await expect(first.read(other, track)).rejects.toThrow("different account");
    await expect(first.save(other, track, new Response("foreign audio"), signal)).rejects.toThrow(
      "different account",
    );
    expect(await new Storage(account).audio.list()).toHaveLength(2);
    const name = await hashedFileName(own.key, ".audio");
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
    const name = await hashedFileName(entry.key, ".audio");
    disk.files.set(`tracks/${name}`, new File(["legacy"], name, { lastModified: 123 }));
    const audio = new Storage(account).audio;
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
    const storage = new Storage(account);
    const artwork = storage.artwork;
    expect(disk.getDirectory).not.toHaveBeenCalled();
    const empty = await artwork.read();
    expect(empty.images).toEqual([]);
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
    const name = await hashedFileName(`${account.host}\n${account.username}`, ".json");
    expect(disk.files.has(`images/${name}`)).toBe(true);
    expect(disk.lock).toHaveBeenCalledWith(`music-web-covers:${name}`, expect.any(Function));
    expect((await artwork.read()).albums).toEqual([{ id: "album", candidates: ["cover"] }]);
    const other = new Storage({ ...account, username: "other" });
    expect((await other.artwork.read()).images).toEqual([]);
  });

  it("restores the catalog without eagerly opening image files", async () => {
    const disk = installStorage();
    const artwork = new Storage(account).artwork;
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
    const catalog = await artwork.read();
    expect(catalog.images.map((image) => image.id)).toEqual(["a", "b"]);
    expect(catalog.albums[0].candidates).toEqual(["a", "b"]);
    expect(disk.files.get("images/b.image")).toBe("x");
  });

  it("keeps the concurrent winner and removes only the unused image file", async () => {
    const disk = installStorage();
    const storage = new Storage(account);
    const first = storage.artwork;
    const second = storage.artwork;
    const results = await Promise.all([
      first.saveImage("cover", image("first"), undefined, valid),
      second.saveImage("cover", image("second"), undefined, valid),
    ]);
    expect(results.filter((result) => result?.image)).toHaveLength(1);
    expect([...disk.files.keys()].filter((name) => name.endsWith(".image"))).toHaveLength(1);
    const catalog = await first.read();
    expect(catalog.images).toHaveLength(1);
    const winner = results.find((result) => result?.image)!;
    expect(await (await second.readImage(catalog.images[0])).text()).toBe(
      await winner.image!.blob.text(),
    );
  });

  it("preserves cached bytes and catalog after failed or cancelled replacements", async () => {
    const disk = installStorage();
    const artwork = new Storage(account).artwork;
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
    expect(await artwork.read()).toEqual(original!.catalog);
    expect(await (await artwork.readImage(previous)).text()).toBe("image");
    expect([...disk.files.keys()].filter((name) => name.endsWith(".image"))).toEqual([
      `images/${previous.fileName}`,
    ]);
  });

  it("does not repair corrupt catalogs or adopt legacy images implicitly", async () => {
    const disk = installStorage();
    const artwork = new Storage(account).artwork;
    const path = `images/${await hashedFileName(`${account.host}\n${account.username}`, ".json")}`;
    disk.files.set(path, "broken JSON");
    disk.files.set("images/legacy.image", "legacy");
    await expect(artwork.read()).rejects.toThrow();
    await expect(artwork.update((catalog) => catalog, valid)).rejects.toThrow();
    await expect(artwork.saveImage("cover", image(), undefined, valid)).rejects.toThrow();
    expect(disk.files.get(path)).toBe("broken JSON");
    expect([...disk.files.keys()]).toEqual([path, "images/legacy.image"]);
  });
});
