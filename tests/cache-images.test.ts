import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache, CacheLoadError, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
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
const path = (disk: ReturnType<typeof installDisk>) =>
  [...disk.files.keys()].find((path) => path.endsWith("/images.json"))!;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("memory-first artwork", () => {
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
    await cache.flush();
    const json = JSON.parse([...disk.files.values()][0]);
    expect(Object.keys(json).sort()).toEqual([
      "albums",
      "artists",
      "lastModified",
      "savedAt",
      "tracks",
    ]);
    expect(disk.blobs.size).toBe(0);
  });

  it("retains images and their catalog when the library changes", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary(library());
    await cache.saveImage("album-art", image());
    await cache.flush();
    const images = cache.images;
    const catalog = disk.files.get(path(disk));
    const next = library();
    next.savedAt++;
    next.tracks[0].artworkId = "new-art";
    await cache.replaceLibrary(next);
    await cache.flush();
    expect(cache.trackArtwork.get("track")?.[0]).toBe("new-art");
    expect(cache.images).toBe(images);
    expect(disk.files.get(path(disk))).toBe(catalog);
  });

  it("publishes after binary close, without reopening image bytes or waiting for JSON", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const reads: string[] = [];
    disk.state.beforeRead = async (path) => {
      reads.push(path);
    };
    disk.state.beforeClose = async (path) => {
      if (path.endsWith(".image")) expect(cache.images.size).toBe(0);
    };
    const saved = await cache.saveImage("cover", image());
    expect(saved?.record).toBe(cache.images.get("cover"));
    expect(saved?.blob.type).toBe("image/png");
    expect(await saved?.blob.text()).toBe("image");
    expect(reads.some((path) => path.endsWith(".image"))).toBe(false);
    expect(disk.files.size).toBe(0);
    expect(disk.blobs.size).toBe(1);
    await cache.flush();
  });

  it("keeps old bytes until the removing checkpoint commits, including failure and retry", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("old"));
    await cache.flush();
    const old = cache.images.get("cover")!;
    const oldJSON = disk.files.get(path(disk));
    await cache.saveImage("cover", image("new"));
    expect(disk.blobs.size).toBe(2);
    disk.state.failClose = true;
    await expect(cache.flush()).rejects.toThrow();
    expect(disk.files.get(path(disk))).toBe(oldJSON);
    expect(disk.blobs.size).toBe(2);
    const restored = new Cache(account);
    await restored.load();
    expect(await (await restored.readImage("cover"))!.blob.text()).toBe("old");
    disk.state.failClose = false;
    await cache.flush();
    expect(disk.blobs.size).toBe(1);
    expect([...disk.blobs.keys()].some((path) => path.endsWith(old.fileName))).toBe(false);
  });

  it("does not delete bytes removed by an edit newer than the in-flight checkpoint", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("first"));
    await cache.flush();
    await cache.saveImage("cover", image("second"));
    const closing = deferred();
    const release = deferred();
    disk.state.beforeClose = async (path) => {
      if (path.endsWith("/images.json")) {
        closing.resolve();
        await release.promise;
      }
    };
    const saving = cache.flush();
    await closing.promise;
    await cache.saveImage("cover", image("third"));
    release.resolve();
    await saving;
    expect(disk.blobs.size).toBe(2);
    const restored = new Cache(account);
    await restored.load();
    expect(await (await restored.readImage("cover"))!.blob.text()).toBe("second");
    await cache.flush();
    expect(disk.blobs.size).toBe(1);
  });

  it("updates or evicts only the observed version", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("old"));
    const old = cache.images.get("cover")!;
    await cache.saveImage("cover", image("new"));
    const next = cache.images.get("cover")!;
    await cache.updateImage("cover", old.fileName, { etag: "wrong" });
    await cache.evictImage("cover", old.fileName);
    expect(cache.images.get("cover")).toBe(next);
    await cache.updateImage("cover", next.fileName, { etag: "new" });
    expect(cache.images.get("cover")?.etag).toBe("new");
    await cache.flush();
    await cache.evictImage("cover", next.fileName);
    expect(cache.images.size).toBe(0);
    expect(disk.blobs.size).toBe(1);
    await cache.flush();
    expect(disk.blobs.size).toBe(0);
  });

  it("lets the first completed same-cache replacement win and removes losing bytes", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("old"));
    await cache.flush();
    const closing = deferred();
    const release = deferred();
    let first = true;
    disk.state.beforeClose = async (path) => {
      if (path.endsWith(".image") && first) {
        first = false;
        closing.resolve();
        await release.promise;
      }
    };
    const slow = cache.saveImage("cover", image("slow"));
    await closing.promise;
    await cache.saveImage("cover", image("winner"));
    expect(await (await cache.readImage("cover"))!.blob.text()).toBe("winner");
    release.resolve();
    expect(await slow).toBeUndefined();
    await cache.flush();
    expect(disk.blobs.size).toBe(1);
  });

  it.each(["binary failure", "cancellation"])("cleans unowned bytes on %s", async (kind) => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.saveImage("cover", image("old"));
    await cache.flush();
    const controller = new AbortController();
    disk.state.beforeClose = async (path) => {
      if (!path.endsWith(".image")) return;
      if (kind === "cancellation") controller.abort();
      else throw new Error("Full");
    };
    await expect(cache.saveImage("cover", image("new"), controller.signal)).rejects.toThrow();
    expect(await (await cache.readImage("cover"))!.blob.text()).toBe("old");
    expect(disk.blobs.size).toBe(1);
  });

  it.each(["duplicate ID", "shared file", "unexpected field"])(
    "preserves invalid catalogs: %s",
    async (kind) => {
      const disk = installDisk();
      const seed = new Cache(account);
      await seed.saveImage("cover", image());
      await seed.flush();
      const records = JSON.parse(disk.files.get(path(disk))!);
      if (kind === "duplicate ID") records.push({ ...records[0], fileName: "other.image" });
      if (kind === "shared file") records.push({ ...records[0], id: "other" });
      if (kind === "unexpected field") records[0].unexpected = true;
      const invalid = JSON.stringify(records);
      disk.files.set(path(disk), invalid);
      const cache = new Cache(account);
      await expect(cache.load()).rejects.toBeInstanceOf(CacheLoadError);
      await expect(cache.saveImage("other", image())).rejects.toThrow();
      expect(disk.files.get(path(disk))).toBe(invalid);
      expect(disk.blobs.size).toBe(1);
    },
  );
});
