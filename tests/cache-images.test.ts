import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { Cache, CacheLoadError, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { observeCache } from "./cache-reactivity.test.svelte";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const image = (value = "image") => ({
  blob: new Blob([value]),
  type: "image/png",
  etag: "etag",
  lastModified: "yesterday",
});
function library(): LibrarySnapshot {
  return {
    savedAt: 100,
    lastModified: 10,
    artists: [{ id: "artist", name: "Artist", artworkId: "artist-art", genres: [] }],
    albums: [
      {
        id: "album",
        title: "Album",
        artistId: "artist",
        artworkId: "album-art",
        year: 2000,
        genres: [],
      },
      {
        id: "older",
        title: "Older",
        artistId: "artist",
        artworkId: "older-art",
        year: 1990,
        genres: [],
      },
    ],
    tracks: [
      {
        id: "track",
        title: "Track",
        artistId: "artist",
        albumId: "album",
        artworkId: "track-art",
        genres: [],
        number: 2,
      },
      {
        id: "first",
        title: "First",
        artistId: "artist",
        albumId: "album",
        artworkId: "album-art",
        genres: [],
        number: 1,
      },
    ],
  };
}
function catalogPath(disk: ReturnType<typeof installDisk>) {
  return [...disk.files.keys()].find((path) => path.endsWith("/images.json"))!;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("artwork cache foundation", () => {
  it("derives ordered, deduplicated candidates without persisting relationships", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary(library());
    expect(cache.albumArtwork.get("album")).toEqual(["album-art", "track-art"]);
    expect(cache.artistArtwork.get("artist")).toEqual([
      "artist-art",
      "older-art",
      "album-art",
      "track-art",
    ]);
    expect(cache.trackArtwork.get("track")).toEqual([
      "track-art",
      "album-art",
      "artist-art",
      "older-art",
    ]);
    expect(cache.trackArtwork.get("first")).toEqual(["album-art", "artist-art", "older-art"]);
    expect(disk.files.size).toBe(1);
    const json = JSON.parse([...disk.files.values()][0]!);
    expect(json).toEqual(library());
    expect(disk.blobs.size).toBe(0);
  });

  it("reacts to library replacements while retaining downloaded images and their catalog", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary(library());
    await cache.saveImage("album-art", image());
    const images = cache.images;
    const catalog = disk.files.get(catalogPath(disk));
    const seen: unknown[] = [];
    const stop = observeCache(() => {
      seen.push(cache.trackArtwork.get("track"));
    });
    try {
      flushSync();
      const next = library();
      next.savedAt++;
      next.tracks[0]!.artworkId = "new-art";
      await cache.replaceLibrary(next);
      flushSync();
      expect(seen).toEqual([
        ["track-art", "album-art", "artist-art", "older-art"],
        ["new-art", "album-art", "artist-art", "older-art"],
      ]);
      expect(cache.images).toBe(images);
      expect(disk.files.get(catalogPath(disk))).toBe(catalog);
    } finally {
      stop();
    }
  });

  it("commits bytes before the catalog and publishes records only after both closes", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const read = vi.fn(async (_path: string) => {});
    disk.state.beforeRead = read;
    disk.state.beforeClose = async (path) => {
      expect(cache.images.size).toBe(0);
      if (path.endsWith("/images.json")) expect(disk.blobs.size).toBe(1);
    };
    const saved = await cache.saveImage("cover", image());
    expect(await saved!.blob.text()).toBe("image");
    expect(saved!.blob.type).toBe("image/png");
    expect(saved!.record).toBe(cache.images.get("cover"));
    expect(read.mock.calls.some(([path]) => path.endsWith(".image"))).toBe(false);
    expect(cache.images.get("cover")).toMatchObject({
      id: "cover",
      size: 5,
      type: "image/png",
      etag: "etag",
      lastModified: "yesterday",
    });
    expect(catalogPath(disk)).toMatch(/^accounts\/[a-f0-9]{64}\/images\.json$/);
    expect([...disk.blobs.keys()][0]).toMatch(/^accounts\/[a-f0-9]{64}\/files\/[a-f0-9-]+\.image$/);
    expect(JSON.parse(disk.files.get(catalogPath(disk))!)).toEqual([...cache.images.values()]);
  });

  it("lets the first completed image win without blocking reads or other writes", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("old"));
    const closing = deferred<void>();
    const release = deferred<void>();
    let held = false;
    disk.state.beforeClose = async (path) => {
      if (path.endsWith(".image") && !held) {
        held = true;
        closing.resolve();
        await release.promise;
      }
    };
    const slow = cache.saveImage("cover", image("slow"));
    await closing.promise;
    try {
      const fast = await cache.saveImage("cover", image("fast"));
      expect(await fast!.blob.text()).toBe("fast");
      expect(await (await cache.readImage("cover"))!.blob.text()).toBe("fast");
    } finally {
      release.resolve();
    }
    expect(await slow).toBeUndefined();
    expect(disk.blobs.size).toBe(1);
    expect(await (await cache.readImage("cover"))!.blob.text()).toBe("fast");
  });

  it("returns the matching image record even if replacement occurs during materialization", async () => {
    installDisk();
    const cache = new Cache(account);
    const old = await cache.saveImage("cover", image("old"));
    const reading = deferred<void>();
    const release = deferred<void>();
    const arrayBuffer = File.prototype.arrayBuffer;
    vi.spyOn(File.prototype, "arrayBuffer").mockImplementation(async function (this: File) {
      const bytes = await arrayBuffer.call(this);
      if (this.name === old!.record.fileName) {
        reading.resolve();
        await release.promise;
      }
      return bytes;
    });
    const pending = cache.readImage("cover");
    await reading.promise;
    try {
      await cache.saveImage("cover", { ...image("new"), type: "image/jpeg" });
    } finally {
      release.resolve();
    }
    const opened = (await pending)!;
    expect(opened.record).toBe(old!.record);
    expect(opened.record.fileName).not.toBe(cache.images.get("cover")!.fileName);
    expect(opened.blob.type).toBe("image/png");
    expect(await opened.blob.text()).toBe("old");
  });

  it("loads only image records at startup and reads bytes lazily", async () => {
    const disk = installDisk();
    const initial = new Cache(account);
    await initial.saveImage("cover", image());
    const read = vi.fn(async (_path: string) => {});
    disk.state.beforeRead = read;
    const restored = new Cache(account);
    await restored.load();
    expect(restored.images.get("cover")).toEqual(initial.images.get("cover"));
    expect(read.mock.calls.every(([path]) => path.endsWith(".json"))).toBe(true);
    expect(await (await restored.readImage("cover"))!.blob.text()).toBe("image");
    expect(read.mock.calls.at(-1)![0]).toMatch(/\.image$/);
    expect(await restored.readImage("unknown")).toBeNull();
  });

  it.each(["binary", "catalog"])(
    "preserves the old image and cleans up uncommitted bytes on %s failure",
    async (stage) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.saveImage("cover", image("old"));
      const originalFiles = [...disk.files];
      const originalBlobs = [...disk.blobs];
      const previous = cache.images;
      disk.state.beforeClose = async (path) => {
        if (stage === "binary" ? path.endsWith(".image") : path.endsWith("/images.json"))
          throw new Error("Disk full");
      };
      await expect(cache.saveImage("cover", image("new"))).rejects.toThrow("Disk full");
      expect(cache.images).toBe(previous);
      expect(cache.imagesError).toBeInstanceOf(Error);
      expect([...disk.files]).toEqual(originalFiles);
      expect([...disk.blobs]).toEqual(originalBlobs);
      disk.state.beforeClose = async () => {};
      await cache.saveImage("cover", image("retry"));
      expect(cache.imagesError).toBeUndefined();
      expect(disk.blobs.size).toBe(1);
    },
  );

  it("cleans up replaced bytes after a successful catalog commit", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("old"));
    const original = [...disk.blobs.keys()][0]!;
    await cache.saveImage("cover", image("replacement"));
    expect(disk.blobs.has(original)).toBe(false);
    expect(disk.blobs.size).toBe(1);
    expect(cache.images.size).toBe(1);
    expect(await (await cache.readImage("cover"))!.blob.text()).toBe("replacement");
  });

  it.each(["binary", "catalog", "after commit"])(
    "handles cancellation during %s without deleting a committed image",
    async (stage) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.saveImage("cover", image("old"));
      const previous = cache.images;
      const controller = new AbortController();
      disk.state.beforeWrite = (path) => {
        if (
          stage === "binary"
            ? path.endsWith(".image")
            : stage === "catalog" && path.endsWith("/images.json")
        )
          controller.abort();
      };
      disk.state.afterClose = (path) => {
        if (stage === "after commit" && path.endsWith("/images.json")) controller.abort();
      };
      await expect(cache.saveImage("cover", image("new"), controller.signal)).rejects.toMatchObject(
        { name: "AbortError" },
      );
      expect(cache.images).toBe(previous);
      expect(cache.imagesError).toBeUndefined();
      expect(disk.blobs.size).toBe(1);
      const restored = new Cache(account);
      await restored.load();
      expect(await (await restored.readImage("cover"))!.blob.text()).toBe(
        stage === "after commit" ? "new" : "old",
      );
    },
  );

  it("keeps the first completed competing replacement and removes the loser's bytes", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache(account);
    const results = await Promise.all([
      first.saveImage("cover", image("first")),
      second.saveImage("cover", image("second")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(disk.blobs.size).toBe(1);
    expect(first.images.get("cover")).toEqual(second.images.get("cover"));
    expect(await (await second.readImage("cover"))!.blob.text()).toBe(
      await results.find(Boolean)!.blob.text(),
    );
  });

  it("merges concurrent saves of different images across cache instances", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache(account);
    await Promise.all([first.saveImage("first", image()), second.saveImage("second", image())]);
    const restored = new Cache(account);
    await restored.load();
    expect([...restored.images.keys()].sort()).toEqual(["first", "second"]);
    expect(disk.blobs.size).toBe(2);
  });

  it.each(["missing", "incomplete"])(
    "repairs %s bytes on access without deleting other records",
    async (damage) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.saveImage("cover", image());
      const binary = [...disk.blobs.keys()][0]!;
      await cache.saveImage("other", image());
      if (damage === "missing") disk.blobs.delete(binary);
      else disk.blobs.set(binary, new Blob(["bad"]));
      expect(await cache.readImage("cover")).toBeNull();
      expect(cache.images.has("cover")).toBe(false);
      expect(cache.images.has("other")).toBe(true);
      expect(disk.blobs.has(binary)).toBe(false);
      expect(JSON.parse(disk.files.get(catalogPath(disk))!)).toHaveLength(1);
    },
  );

  it("does not delete a competing winner when an old cached reference is missing", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    await first.saveImage("cover", image("old"));
    const second = new Cache(account);
    await second.load();
    await second.saveImage("cover", image("new"));
    const opened = await first.readImage("cover");
    expect(first.images.get("cover")).toEqual(second.images.get("cover"));
    expect(opened!.record).toBe(first.images.get("cover"));
    expect(await opened!.blob.text()).toBe("new");
    expect(disk.blobs.size).toBe(1);
  });

  it("propagates inaccessible bytes without removing their catalog entry", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image());
    const previous = cache.images;
    const error = new DOMException("Denied", "NotAllowedError");
    disk.state.beforeRead = async (path) => {
      if (path.endsWith(".image")) throw error;
    };
    await expect(cache.readImage("cover")).rejects.toBe(error);
    expect(cache.images).toBe(previous);
    expect(cache.imagesError).toBe(error);
    expect(disk.blobs.size).toBe(1);
  });

  it("keeps corrupt image catalogs intact while restoring the library and queue", async () => {
    const disk = installDisk();
    const initial = new Cache(account);
    await initial.saveImage("cover", image());
    await initial.replaceLibrary(library());
    initial.setQueue({ tracks: ["track"], index: 0, position: 5 });
    await initial.flush();
    disk.files.set(catalogPath(disk), "corrupt");
    const cache = new Cache(account);
    const error = await cache.load().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CacheLoadError);
    expect(cache.imagesError).toBeInstanceOf(Error);
    expect(cache.artists.size).toBe(1);
    expect(cache.queue.position).toBe(5);
    await expect(cache.saveImage("new", image())).rejects.toThrow();
    expect(disk.files.get(catalogPath(disk))).toBe("corrupt");
    expect(disk.blobs.size).toBe(1);
  });

  it.each(["duplicate ID", "shared file", "unexpected field"])(
    "rejects invalid image catalogs: %s",
    async (kind) => {
      const disk = installDisk();
      const initial = new Cache(account);
      await initial.saveImage("cover", image());
      const path = catalogPath(disk);
      const catalog = JSON.parse(disk.files.get(path)!);
      if (kind === "unexpected field") catalog[0].unexpected = true;
      else
        catalog.push({
          ...catalog[0],
          id: kind === "shared file" ? "other" : "cover",
        });
      disk.files.set(path, JSON.stringify(catalog));
      const cache = new Cache(account);
      await expect(cache.load()).rejects.toBeInstanceOf(CacheLoadError);
      expect(cache.images.size).toBe(0);
    },
  );

  it("cancels a pending catalog load without publishing or recording an image error", async () => {
    const disk = installDisk();
    const initial = new Cache(account);
    await initial.saveImage("cover", image());
    const reading = deferred();
    const release = deferred();
    disk.state.beforeRead = async (path) => {
      if (path.endsWith("/images.json")) {
        reading.resolve();
        await release.promise;
      }
    };
    const cache = new Cache(account);
    const controller = new AbortController();
    const loaded = cache.load(controller.signal);
    await reading.promise;
    controller.abort();
    release.resolve();
    await expect(loaded).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.images.size).toBe(0);
    expect(cache.imagesError).toBeUndefined();
  });

  it("isolates image records and bytes for accounts with the same artwork IDs", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache({ ...account, username: "other" });
    await Promise.all([
      first.saveImage("cover", image("first")),
      second.saveImage("cover", image("second")),
    ]);
    await Promise.all([first.load(), second.load()]);
    expect(await (await first.readImage("cover"))!.blob.text()).toBe("first");
    expect(await (await second.readImage("cover"))!.blob.text()).toBe("second");
    expect(disk.files.size).toBe(2);
    expect(disk.blobs.size).toBe(2);
  });
});
