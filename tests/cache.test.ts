import { getAccountKey } from "../src/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { observeCache } from "./cache-reactivity.test.svelte";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { deferred } from "./session-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
function library(savedAt = 100): LibrarySnapshot {
  return {
    lastModified: 10,
    savedAt,
    artists: [{ id: "artist", name: "Artist" }],
    albums: [{ id: "album", title: "Album", artistIds: ["artist"], genres: [] }],
    tracks: [{ id: "track", title: "Track", artistIds: ["artist"], albumId: "album", genres: [] }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account cache clear", () => {
  it("ignores queue position updates while deletion is held without throwing or writing", async () => {
    const disk = installDisk();
    const cache = new Cache("selected");
    cache.setQueue({ tracks: ["track"], index: 0, position: 12 });
    await cache.flush();
    const revision = cache.queueRevision;
    const writes = disk.state.writes;
    const root = await navigator.storage.getDirectory();
    const accounts = await root.getDirectoryHandle("accounts");
    vi.spyOn(root, "getDirectoryHandle").mockResolvedValue(accounts);
    disk.getDirectory.mockResolvedValue(root);
    const entered = deferred();
    const release = deferred();
    const remove = accounts.removeEntry.bind(accounts);
    vi.spyOn(accounts, "removeEntry").mockImplementation(async (name, options) => {
      entered.resolve();
      await release.promise;
      await remove(name, options);
    });
    const clearing = cache.clear();
    await entered.promise;
    try {
      expect(() =>
        cache.setQueue({ ...cache.queue, position: 13 }, { checkpoint: true }),
      ).not.toThrow();
      expect(cache.queue.position).toBe(12);
      expect(cache.queueRevision).toBe(revision);
      await cache.flush();
      expect(disk.state.writes).toBe(writes);
    } finally {
      release.resolve();
      await clearing;
    }
    await cache.flush();
    expect(disk.state.writes).toBe(writes);
    expect(disk.files.size).toBe(0);
  });

  it("reactively empties cache-owned data and remains writable with the same key", async () => {
    const disk = installDisk();
    const cache = new Cache("selected");
    await cache.replaceLibrary(library());
    cache.setQueue({ tracks: ["track"], index: 0, position: 12 });
    cache.setPlaylists({ listedAt: 1, summaries: [{ id: "p", name: "Mix" }], details: [] });
    await cache.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" });
    const track = { id: "track", title: "Track", artist: "Artist", album: "Album" };
    await cache.saveDownload(
      track,
      "raw",
      "audio/mpeg",
      new Response("audio"),
      new AbortController().signal,
    );
    await cache.flush();
    const states: number[][] = [];
    const dispose = observeCache(() => {
      states.push([
        cache.tracks.size,
        cache.images.size,
        cache.downloads.size,
        cache.queue.tracks.length,
        cache.playlists.summaries.length,
      ]);
    });
    flushSync();
    try {
      expect(states.at(-1)).toEqual([1, 1, 1, 1, 1]);
      await cache.clear();
      flushSync();
      expect(states.at(-1)).toEqual([0, 0, 0, 0, 0]);
      expect(cache.key).toBe("selected");
      expect(cache.queue).toEqual({ tracks: [], index: -1, position: 0 });
      expect(cache.error).toBeUndefined();
      expect(cache.dirty).toBe(false);
      expect(disk.files.size + disk.blobs.size).toBe(0);
      await cache.load();
      await cache.saveImage("new", { blob: new Blob(["new image"]), type: "image/png" });
      await cache.saveDownload(
        track,
        "raw",
        "audio/mpeg",
        new Response("new audio"),
        new AbortController().signal,
      );
      cache.setQueue({ tracks: ["track"], index: 0, position: 0 });
      await cache.flush();
      expect(cache.images.has("new")).toBe(true);
      expect((await cache.readDownload("track", "raw"))?.size).toBe(9);
      expect(cache.queue.index).toBe(0);
    } finally {
      dispose();
    }
  });

  it("does not republish old hydration after clearing", async () => {
    const disk = installDisk();
    const seed = new Cache("selected");
    await seed.replaceLibrary(library());
    await seed.flush();
    const cache = new Cache("selected");
    const read = deferred();
    let reading = false;
    disk.state.beforeRead = async (path) => {
      if (path.endsWith("library.json")) {
        reading = true;
        await read.promise;
      }
    };
    const loading = cache.load();
    await vi.waitFor(() => expect(reading).toBe(true));
    const clearing = cache.clear();
    read.resolve();
    await Promise.all([loading, clearing]);
    expect(cache.tracks.size).toBe(0);
    expect(cache.savedAt).toBeUndefined();
    await cache.flush();
    expect(disk.files.size).toBe(0);
  });

  it("joins an in-flight checkpoint, cancels timers, and deletes only its account", async () => {
    const disk = installDisk();
    const cache = new Cache("selected");
    const other = new Cache("unrelated");
    await other.replaceLibrary(library());
    await other.flush();
    disk.files.set("application/asset.js", "application asset");
    const unrelated = [...disk.files.keys()];
    const close = deferred();
    let writing = false;
    disk.state.beforeClose = async () => {
      writing = true;
      await close.promise;
    };
    await cache.replaceLibrary(library());
    const flushing = cache.flush();
    await vi.waitFor(() => expect(writing).toBe(true));
    let deleted = false;
    const clearing = cache.clear();
    expect(cache.clear()).toBe(clearing);
    const deleting = clearing.then(() => {
      deleted = true;
    });
    await Promise.resolve();
    expect(deleted).toBe(false);
    close.resolve();
    await Promise.all([flushing, deleting]);
    expect([...disk.files.keys()]).toEqual(unrelated);
    expect(cache.artists.size).toBe(0);
    expect(cache.tracks.size).toBe(0);
    expect(cache.savedAt).toBeUndefined();
    await cache.load();
    await cache.flush();
    expect([...disk.files.keys()]).toEqual(unrelated);
    await cache.replaceLibrary(library(200));
    await cache.flush();
    expect(cache.savedAt).toBe(200);
    expect(cache.tracks.size).toBe(1);
    await cache.clear();
    expect([...disk.files.keys()]).toEqual(unrelated);
  });

  it("joins a late binary close without publishing artwork or recreating the directory", async () => {
    const disk = installDisk();
    const cache = new Cache("selected");
    const close = deferred();
    let writing = false;
    disk.state.beforeClose = async (path) => {
      if (path.endsWith(".image")) {
        writing = true;
        await close.promise;
      }
    };
    const saving = cache.saveImage("cover", { blob: new Blob(["image"]), type: "image/png" });
    await vi.waitFor(() => expect(writing).toBe(true));
    let deleted = false;
    const deleting = cache.clear().then(() => {
      deleted = true;
    });
    await Promise.resolve();
    expect(deleted).toBe(false);
    close.resolve();
    await Promise.all([saving, deleting]);
    expect(cache.images.size).toBe(0);
    expect(disk.files.size).toBe(0);
    expect(disk.blobs.size).toBe(0);
    await cache.flush();
    expect(disk.files.size).toBe(0);
  });

  it("remains loadable and writable after deletion failure, and can retry clearing", async () => {
    const disk = installDisk();
    const cache = new Cache("selected");
    await cache.replaceLibrary(library());
    await cache.flush();
    disk.state.failRemove = true;
    await expect(cache.clear()).rejects.toThrow("Deletion denied");
    expect(disk.files.size).toBe(1);
    await cache.load();
    expect(cache.tracks.size).toBe(1);
    await cache.replaceLibrary(library(200));
    cache.setQueue({ tracks: ["track"], index: 0, position: 12 });
    await cache.flush();
    const restored = new Cache("selected");
    await restored.load();
    expect(restored.savedAt).toBe(200);
    expect(restored.queue.position).toBe(12);
    disk.state.failRemove = false;
    await cache.clear();
    expect(disk.files.size).toBe(0);
  });
});

describe("memory-first library", () => {
  it("constructs an empty key-scoped view without I/O", () => {
    const disk = installDisk();
    const input = { ...account };
    const cache = new Cache(getAccountKey(input));
    input.username = "other";
    expect(cache.key).toBe(getAccountKey(account));
    expect(cache.savedAt).toBeUndefined();
    expect(cache.tracks.size).toBe(0);
    expect(disk.getDirectory).not.toHaveBeenCalled();
  });

  it("publishes owned, related reactive views together before persistence", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    const seen: unknown[] = [];
    const stop = observeCache(() =>
      seen.push([cache.artists.size, cache.albums.size, cache.tracks.size, cache.savedAt]),
    );
    try {
      flushSync();
      const input = library();
      const replaced = cache.replaceLibrary(input);
      input.tracks[0].title = "Changed";
      input.tracks.length = 0;
      await replaced;
      flushSync();
      expect(seen).toEqual([
        [0, 0, 0, undefined],
        [1, 1, 1, 100],
      ]);
      expect(cache.tracks.get("track")?.title).toBe("Track");
      expect(disk.files.size).toBe(0);
      expect(cache.dirty).toBe(true);
      await cache.flush();
      const [path, json] = [...disk.files][0];
      expect(path).toMatch(/^accounts\/[a-f0-9]{64}\/library\.json$/);
      expect(JSON.parse(json)).toEqual(library());
      const restored = new Cache(getAccountKey(account));
      await restored.load();
      expect(restored.tracks).toEqual(cache.tracks);
      expect(restored.tracks.get("track")).toBe(restored.albumTracks.get("album")![0]);
      expect(restored.albums.get("album")).toBe(restored.artistAlbums.get("artist")![0]);
    } finally {
      stop();
    }
  });

  it("derives sorted relationships without duplicating persisted records", async () => {
    installDisk();
    const cache = new Cache(getAccountKey(account));
    const value = library();
    value.artists.unshift({ id: "z", name: "Z" });
    value.albums.push({ ...value.albums[0], id: "older", year: 1990 });
    value.tracks.push({ ...value.tracks[0], id: "first", number: 1 });
    await cache.replaceLibrary(value);
    expect([...cache.artists.keys()]).toEqual(["artist", "z"]);
    expect(cache.artistAlbums.get("artist")!.map((a) => a.id)).toEqual(["older", "album"]);
    expect(cache.albumTracks.get("album")!.map((t) => t.id)).toEqual(["first", "track"]);
    await cache.flush();
  });

  it("keeps memory authoritative after loading, without rereading disk on writes", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    await cache.replaceLibrary(library());
    await cache.flush();
    const read = vi.fn(async () => {
      throw new Error("Should not read");
    });
    disk.state.beforeRead = read;
    await cache.load();
    await cache.replaceLibrary(library(200));
    await cache.flush();
    expect(read).not.toHaveBeenCalled();
    expect(cache.savedAt).toBe(200);
  });

  it("preserves new memory and old disk on checkpoint failure, then retries", async () => {
    const disk = installDisk();
    const cache = new Cache(getAccountKey(account));
    await cache.replaceLibrary(library());
    await cache.flush();
    const files = [...disk.files];
    disk.state.failClose = true;
    await cache.replaceLibrary(library(200));
    await expect(cache.flush()).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: "Storage full" })]),
    });
    expect(cache.savedAt).toBe(200);
    expect(cache.error).toBeDefined();
    expect(cache.dirty).toBe(true);
    expect([...disk.files]).toEqual(files);
    disk.state.failClose = false;
    await cache.flush();
    expect(cache.error).toBeUndefined();
    expect(cache.dirty).toBe(false);
  });

  it.each(["invalid JSON", "duplicate IDs", "unexpected field"])(
    "preserves %s until authoritative replacement is flushed",
    async (kind) => {
      const disk = installDisk();
      const seed = new Cache(getAccountKey(account));
      await seed.replaceLibrary(library());
      await seed.flush();
      const path = [...disk.files.keys()][0];
      const invalid = library();
      invalid.tracks.push(invalid.tracks[0]);
      const corrupt =
        kind === "invalid JSON"
          ? "broken"
          : JSON.stringify(kind === "duplicate IDs" ? invalid : { ...library(), unexpected: true });
      disk.files.set(path, corrupt);
      const cache = new Cache(getAccountKey(account));
      await expect(cache.load()).rejects.toThrow();
      expect(disk.files.get(path)).toBe(corrupt);
      await cache.replaceLibrary(library(200));
      expect(disk.files.get(path)).toBe(corrupt);
      await cache.flush();
      expect(JSON.parse(disk.files.get(path)!)).toEqual(library(200));
    },
  );

  it("does not overwrite a replacement with late hydration", async () => {
    const disk = installDisk();
    const seed = new Cache(getAccountKey(account));
    await seed.replaceLibrary(library());
    await seed.flush();
    const cache = new Cache(getAccountKey(account));
    const reading = deferred();
    const release = deferred();
    disk.state.beforeRead = async () => {
      reading.resolve();
      await release.promise;
    };
    const loading = cache.load();
    await reading.promise;
    await cache.replaceLibrary(library(200));
    release.resolve();
    await loading;
    expect(cache.savedAt).toBe(200);
    await cache.flush();
  });

  it("rejects cancellation before publication; later cancellation does not undo adopted data", async () => {
    installDisk();
    const cache = new Cache(getAccountKey(account));
    const controller = new AbortController();
    controller.abort();
    await expect(cache.replaceLibrary(library(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cache.savedAt).toBeUndefined();
    const next = new AbortController();
    await cache.replaceLibrary(library(), next.signal);
    next.abort();
    await cache.flush();
    expect(cache.savedAt).toBe(100);
  });

  it("rejects older in-memory snapshots before projecting them", async () => {
    installDisk();
    const cache = new Cache(getAccountKey(account));
    await cache.replaceLibrary(library(200));
    const previous = cache.artists;
    await cache.replaceLibrary(library(100));
    await cache.replaceLibrary({ ...library(300), lastModified: 9 });
    expect(cache.artists).toBe(previous);
    await cache.replaceLibrary({ ...library(300), lastModified: null });
    await cache.replaceLibrary({ ...library(200), lastModified: null });
    expect(cache.savedAt).toBe(300);
    await cache.flush();
  });
});
