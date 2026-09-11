import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "./cache.svelte";
import { installDisk } from "./cache-test-helpers";

const account = { host: "https://music.example", username: "listener" };
const library = (savedAt = 1) => ({
  savedAt,
  lastModified: savedAt,
  artists: [],
  albums: [],
  tracks: [],
});
const queue = { tracks: ["track"], index: 0, position: 1 };
const image = { blob: new Blob(["image"]), type: "image/png" };
const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cache's internal file operations", () => {
  it("shares one lazy account hash across documents and binary lookups", async () => {
    installDisk();
    const digest = vi.spyOn(crypto.subtle, "digest");
    const cache = new Cache(account);
    expect(digest).not.toHaveBeenCalled();
    await cache.load();
    await cache.replaceLibrary(library());
    await cache.saveImage("cover", image);
    await cache.readImage("cover");
    expect(digest).toHaveBeenCalledOnce();
    const hash = Array.from(new Uint8Array(await digest.mock.results[0].value), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const names = vi.mocked(navigator.locks.request).mock.calls.map(([name]) => name);
    expect(new Set(names)).toEqual(
      new Set(
        ["library", "queue", "images", "downloads"].map((name) => `libras-${name}:${hash}.cache`),
      ),
    );
  });

  it("retries account initialization without poisoning any domain", async () => {
    const disk = installDisk();
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("Hash unavailable"));
    const cache = new Cache(account);
    await expect(cache.load()).rejects.toThrow("Hash unavailable");
    expect(disk.getDirectory).not.toHaveBeenCalled();
    await cache.load();
    expect(digest).toHaveBeenCalledTimes(2);
    expect(cache.queueError).toBeUndefined();
    expect(cache.imagesError).toBeUndefined();
    expect(cache.downloadsError).toBeUndefined();
  });

  it.each(["library", "queue"] as const)(
    "never repairs inaccessible %s data as if it were corrupt",
    async (domain) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.replaceLibrary(library());
      cache.setQueue(queue);
      await cache.flush();
      const path = [...disk.files.keys()].find((name) => name.endsWith(`/${domain}.json`))!;
      const original = disk.files.get(path);
      const writes = disk.state.writes;
      const failure = new DOMException("Cannot read file", "NotAllowedError");
      disk.state.beforeRead = async (name) => {
        if (name === path) throw failure;
      };
      const change = () => {
        if (domain === "library") return cache.replaceLibrary(library(2));
        cache.setQueue({ ...queue, position: 2 });
        return cache.flush();
      };
      await expect(change()).rejects.toBe(failure);
      expect(disk.files.get(path)).toBe(original);
      expect(disk.state.writes).toBe(writes);
      // Reading the File's contents can fail after opening it successfully too.
      disk.state.beforeRead = async () => {};
      vi.spyOn(File.prototype, "text").mockRejectedValueOnce(failure);
      await expect(change()).rejects.toBe(failure);
      expect(disk.files.get(path)).toBe(original);
      expect(disk.state.writes).toBe(writes);
      await change();
      expect(disk.files.get(path)).not.toBe(original);
    },
  );

  it.each(["library", "queue"] as const)(
    "still repairs invalid JSON/schema data in %s on write",
    async (domain) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.replaceLibrary(library());
      cache.setQueue(queue);
      await cache.flush();
      const path = [...disk.files.keys()].find((name) => name.endsWith(`/${domain}.json`))!;
      for (const value of ["broken JSON", '{"unexpected":true}']) {
        disk.files.set(path, value);
        if (domain === "library") await cache.replaceLibrary(library(2));
        else {
          cache.setQueue(queue);
          await cache.flush();
        }
        expect(JSON.parse(disk.files.get(path)!).account).toEqual(account);
      }
    },
  );

  it.each(["library", "queue", "images", "downloads"] as const)(
    "retains shared %s placeholders without locks and retries safely",
    async (domain) => {
      const disk = installDisk();
      Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
      const cache = new Cache(account);
      const save = {
        library: () => cache.replaceLibrary(library()),
        queue: () => {
          cache.setQueue(queue);
          return cache.flush();
        },
        images: () => cache.saveImage("cover", image),
        downloads: () =>
          cache.saveDownload(
            track,
            "mp3",
            "audio/mpeg",
            new Response("audio"),
            new AbortController().signal,
          ),
      }[domain];
      let cleanupReads = 0;
      disk.state.beforeRead = async (name) => {
        if (name.endsWith(`/${domain}.json`)) cleanupReads++;
      };
      disk.state.beforeClose = async (name) => {
        if (name.endsWith(`/${domain}.json`)) throw new Error("Close failed");
      };
      await expect(save()).rejects.toThrow("Close failed");
      // A cleanup read of this shared placeholder could see stale size=0 while
      // another instance closes its replacement. Do not inspect or delete it.
      expect(cleanupReads).toBe(0);
      const path = [...disk.files.keys()].find((name) => name.endsWith(`/${domain}.json`))!;
      expect(disk.files.get(path)).toBe("");
      expect(disk.blobs.size).toBe(0);
      disk.state.beforeClose = async () => {};
      await save();
      expect(JSON.parse(disk.files.get(path)!).account).toEqual(account);
      expect(disk.blobs.size).toBe(domain === "images" || domain === "downloads" ? 1 : 0);
    },
  );

  it("preserves write errors when stream abort also fails", async () => {
    const disk = installDisk();
    disk.state.beforeWrite = () => {
      throw new Error("Write failed");
    };
    vi.spyOn(WritableStream.prototype, "abort").mockRejectedValue(new Error("Abort failed"));
    await expect(new Cache(account).replaceLibrary(library())).rejects.toThrow("Write failed");
    expect(disk.files.size).toBe(0);
  });

  it("builds library indexes only once when restoring", async () => {
    installDisk();
    await new Cache(account).replaceLibrary({
      ...library(),
      artists: [
        { id: "b", name: "B", genres: [] },
        { id: "a", name: "A", genres: [] },
      ],
    });
    const compare = vi.spyOn(String.prototype, "localeCompare");
    const cache = new Cache(account);
    await cache.load();
    expect(compare.mock.calls.filter(([name]) => name === "B")).toHaveLength(1);
    expect([...cache.artists.keys()]).toEqual(["a", "b"]);
    expect(cache.savedAt).toBe(1);
    expect(cache.lastModified).toBe(1);
  });

  it("validates scalar queue edits without traversing cached track IDs", async () => {
    installDisk();
    const cache = new Cache(account);
    cache.setQueue(queue);
    const tracks = cache.queue.tracks;
    // Instrument an existing element without changing its value.
    const read = vi.fn(() => "track");
    Object.defineProperty(tracks, "0", { get: read, configurable: true });
    cache.setQueue({ tracks, index: 0, position: 2 }, { checkpoint: true });
    expect(cache.queue.tracks).toBe(tracks);
    expect(read).not.toHaveBeenCalled();
    expect(() => cache.setQueue({ tracks, index: 1, position: 2 })).toThrow();
    expect(() => cache.setQueue({ tracks, index: -1, position: 2 })).toThrow();
    expect(() => cache.setQueue({ tracks, index: 0, position: -1 })).toThrow();
    const extra = { tracks, index: 0, position: 2, unexpected: true };
    expect(() => cache.setQueue(extra)).toThrow();
    let accesses = 0;
    const changing = {
      get tracks() {
        return ++accesses === 1 ? tracks : ["a", "b"];
      },
      index: 1,
      position: 0,
    };
    expect(() => cache.setQueue(changing)).toThrow();
    expect(accesses).toBe(1);
    await cache.flush();
  });
});
