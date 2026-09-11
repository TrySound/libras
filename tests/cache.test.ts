import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { observeCache } from "./cache-reactivity.test.svelte";
import { Cache, type LibrarySnapshot } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";

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

describe("library cache", () => {
  it("constructs an empty account-scoped view without I/O", () => {
    const disk = installDisk();
    const input = { ...account };
    const cache = new Cache(input);
    input.username = "other";
    expect(cache.account).toEqual(account);
    expect(Object.isFrozen(cache.account)).toBe(true);
    expect(cache.savedAt).toBeUndefined();
    expect(cache.lastModified).toBeUndefined();
    expect(cache.tracks.size).toBe(0);
    expect(disk.getDirectory).not.toHaveBeenCalled();
  });

  it("persists one normalized snapshot and reconstructs maps on reload", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.load();
    expect(cache.savedAt).toBeUndefined();
    await cache.replaceLibrary(library());
    const [path, json] = [...disk.files][0]!;
    expect(path).toMatch(/^accounts\/[a-f0-9]{64}\/library\.json$/);
    expect(JSON.parse(json)).toEqual(library());
    const restored = new Cache(account);
    await restored.load();
    expect(restored.savedAt).toBe(100);
    expect(restored.lastModified).toBe(10);
    expect([...restored.artists.values()]).toEqual(library().artists);
    expect([...restored.albums.values()]).toEqual(library().albums);
    expect([...restored.tracks.values()]).toEqual(library().tracks);
    expect(restored.tracks.get("track")).toBe(restored.albumTracks.get("album")![0]);
    expect(restored.albums.get("album")).toBe(restored.artistAlbums.get("artist")![0]);
  });

  it("restores its initial view when the persisted snapshot is absent", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const initialArtists = cache.artists;
    await cache.replaceLibrary(library());
    const path = [...disk.files.keys()].find((path) => path.endsWith("/library.json"));
    if (!path) throw new Error("Expected a persisted library");
    disk.files.delete(path);
    const writes = disk.state.writes;
    await cache.load();
    expect(cache.artists).toBe(initialArtists);
    expect(cache.tracks.size).toBe(0);
    expect(cache.albumTracks.size).toBe(0);
    expect(cache.savedAt).toBeUndefined();
    expect(cache.lastModified).toBeUndefined();
    expect(disk.state.writes).toBe(writes);
  });

  it("derives sorted relationships without duplicating persisted records", async () => {
    installDisk();
    const cache = new Cache(account);
    const value = library();
    value.artists.unshift({ id: "z", name: "Z", genres: [] });
    value.albums.push({ ...value.albums[0]!, id: "older", year: 1990 });
    value.tracks.push({ ...value.tracks[0]!, id: "first", number: 1 });
    await cache.replaceLibrary(value);
    expect([...cache.artists.keys()]).toEqual(["artist", "z"]);
    expect(cache.artistAlbums.get("artist")!.map((a) => a.id)).toEqual(["older", "album"]);
    expect(cache.albumTracks.get("album")!.map((t) => t.id)).toEqual(["first", "track"]);
  });

  it("publishes related reactive views together, only after commit", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    const seen: (number | null | undefined)[][] = [];
    const stop = observeCache(() => {
      seen.push([
        cache.artists.size,
        cache.albums.size,
        cache.tracks.size,
        cache.albumTracks.size,
        cache.savedAt,
        cache.lastModified,
      ]);
    });
    try {
      flushSync();
      disk.state.beforeWrite = () => expect(cache.savedAt).toBeUndefined();
      await cache.replaceLibrary(library());
      flushSync();
      expect(seen).toEqual([
        [0, 0, 0, 0, undefined, undefined],
        [1, 1, 1, 1, 100, 10],
      ]);
    } finally {
      stop();
    }
  });

  it("copies caller-owned input before awaiting persistence", async () => {
    installDisk();
    const cache = new Cache(account);
    const value = library();
    const save = cache.replaceLibrary(value);
    value.tracks[0]!.title = "Changed";
    value.tracks[0]!.genres.push("Changed");
    value.tracks.length = 0;
    await save;
    expect(cache.tracks.get("track")!.title).toBe("Track");
    expect(cache.tracks.get("track")!.genres).toEqual([]);
  });

  it("preserves memory and disk on failed writes and permits retry", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary(library());
    const previous = cache.tracks;
    const files = [...disk.files];
    disk.state.failClose = true;
    await expect(cache.replaceLibrary(library(200))).rejects.toThrow("Storage full");
    expect(cache.tracks).toBe(previous);
    expect(cache.savedAt).toBe(100);
    expect([...disk.files]).toEqual(files);
    disk.state.failClose = false;
    await cache.replaceLibrary(library(200));
    expect(cache.savedAt).toBe(200);
  });

  it.each(["invalid JSON", "duplicate IDs", "unexpected field"])(
    "preserves %s on load and repairs it on replacement",
    async (kind) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.replaceLibrary(library());
      const path = [...disk.files.keys()][0]!;
      const invalid = library();
      invalid.tracks.push(invalid.tracks[0]!);
      const corrupt =
        kind === "invalid JSON"
          ? "broken"
          : JSON.stringify({
              ...(kind === "duplicate IDs" ? invalid : library()),
              ...(kind === "unexpected field" ? { unexpected: true } : {}),
            });
      disk.files.set(path, corrupt);
      const previous = cache.tracks;
      await expect(cache.load()).rejects.toThrow();
      expect(cache.tracks).toBe(previous);
      expect(cache.savedAt).toBe(100);
      expect(disk.files.get(path)).toBe(corrupt);
      await cache.replaceLibrary(library(200));
      expect(cache.savedAt).toBe(200);
    },
  );

  it("serializes load and replacement publication", async () => {
    installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary(library());
    await Promise.all([cache.load(), cache.replaceLibrary(library(200)), cache.load()]);
    expect(cache.savedAt).toBe(200);
  });

  it.each(["beforeWrite", "afterClose"] as const)(
    "does not publish cancelled work (%s)",
    async (stage) => {
      const disk = installDisk();
      const cache = new Cache(account);
      await cache.replaceLibrary(library());
      const controller = new AbortController();
      disk.state[stage] = () => controller.abort();
      await expect(cache.replaceLibrary(library(200), controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(cache.savedAt).toBe(100);
      // Cancellation after atomic close cannot undo the committed file.
      const restored = new Cache(account);
      await restored.load();
      expect(restored.savedAt).toBe(stage === "afterClose" ? 200 : 100);
    },
  );

  it("adopts the newer disk winner across instances under a shared lock", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache(account);
    const winner = library(200);
    winner.tracks = winner.tracks.map((track) => ({ ...track, title: "Winner" }));
    await Promise.all([first.replaceLibrary(winner), second.replaceLibrary(library(100))]);
    expect(second.savedAt).toBe(200);
    expect(second.tracks.get("track")?.title).toBe("Winner");
    expect(second.albumTracks.get("album")?.[0]).toBe(second.tracks.get("track"));
    expect(disk.state.writes).toBe(1);
    await second.replaceLibrary({ ...library(300), lastModified: 9 });
    expect(second.lastModified).toBe(10);
    expect(disk.state.writes).toBe(1);
  });

  it("projects only the winning snapshot, not the rejected candidate", async () => {
    installDisk();
    const snapshot = (name: string, savedAt: number): LibrarySnapshot => ({
      ...library(savedAt),
      artists: [
        { id: "z", name: `${name} Z`, genres: [] },
        { id: "a", name: `${name} A`, genres: [] },
      ],
    });
    await new Cache(account).replaceLibrary(snapshot("Winner", 200));
    const compare = vi.spyOn(String.prototype, "localeCompare");
    const cache = new Cache(account);
    await cache.replaceLibrary(snapshot("Candidate", 100));
    expect(compare).toHaveBeenCalledOnce();
    expect(compare).toHaveBeenCalledWith("Winner Z");
    expect([...cache.artists.values()].map((artist) => artist.name)).toEqual([
      "Winner A",
      "Winner Z",
    ]);
    expect(cache.savedAt).toBe(200);
  });

  it("orders snapshots by savedAt when the server timestamp is unknown", async () => {
    const disk = installDisk();
    const cache = new Cache(account);
    await cache.replaceLibrary({ ...library(200), lastModified: null });
    await cache.replaceLibrary({ ...library(100), lastModified: null });
    expect(cache.savedAt).toBe(200);
    expect(cache.lastModified).toBeNull();
    expect(disk.state.writes).toBe(1);
  });

  it("isolates accounts with overlapping entity IDs", async () => {
    const disk = installDisk();
    const first = new Cache(account);
    const second = new Cache({ ...account, username: "other" });
    await Promise.all([first.replaceLibrary(library(100)), second.replaceLibrary(library(200))]);
    await Promise.all([first.load(), second.load()]);
    expect(first.savedAt).toBe(100);
    expect(second.savedAt).toBe(200);
    expect(disk.files.size).toBe(2);
  });
});
