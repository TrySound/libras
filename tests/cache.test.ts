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
    artists: [{ id: "artist", name: "Artist", genres: [] }],
    albums: [{ id: "album", title: "Album", artistId: "artist", genres: [] }],
    tracks: [{ id: "track", title: "Track", artistId: "artist", albumId: "album", genres: [] }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory-first library", () => {
  it("constructs an empty account-scoped view without I/O", () => {
    const disk = installDisk();
    const input = { ...account };
    const cache = new Cache(input);
    input.username = "other";
    expect(cache.account).toEqual(account);
    expect(Object.isFrozen(cache.account)).toBe(true);
    expect(cache.savedAt).toBeUndefined();
    expect(cache.tracks.size).toBe(0);
    expect(disk.getDirectory).not.toHaveBeenCalled();
  });

  it("publishes owned, related reactive views together before persistence", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
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
      const restored = new Cache(account);
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
    const cache = new Cache(account);
    const value = library();
    value.artists.unshift({ id: "z", name: "Z", genres: [] });
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
    const cache = new Cache(account);
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
    const cache = new Cache(account);
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
      const seed = new Cache(account);
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
      const cache = new Cache(account);
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
    const seed = new Cache(account);
    await seed.replaceLibrary(library());
    await seed.flush();
    const cache = new Cache(account);
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
    const cache = new Cache(account);
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
    const cache = new Cache(account);
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
