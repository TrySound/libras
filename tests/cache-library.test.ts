import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccountKey } from "../src/auth";
import { Cache } from "../src/cache.svelte";
import { account, snapshot, snapshotPath, installMetadataStorage } from "./library-test-helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cached library", () => {
  it("restores sorted stable indexes without changing stored entity order", async () => {
    const storage = installMetadataStorage();
    const data = snapshot();
    data.artists = [
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
    ];
    data.albums = [
      { id: "later", artistIds: ["b", "a", "b"], title: "Later", year: 2020, genres: [] },
      { id: "earlier", artistIds: ["a"], title: "Earlier", year: 2000, genres: [] },
    ];
    data.tracks = [
      {
        id: "second",
        albumId: "earlier",
        artistIds: ["b", "a"],
        title: "Second",
        number: 2,
        genres: [],
      },
      { id: "first", albumId: "earlier", artistIds: ["a"], title: "First", number: 1, genres: [] },
    ];
    await storage.seed(account, data);
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    expect([...cache.artists.values()].map((item) => item.id)).toEqual(["a", "b"]);
    expect(cache.artistAlbums.get("a")?.map((item) => item.id)).toEqual(["earlier", "later"]);
    expect(cache.artistAlbums.get("b")?.map((item) => item.id)).toEqual(["later"]);
    expect(cache.albums.get("later")?.artistIds).toEqual(["b", "a", "b"]);
    expect(cache.tracks.get("second")?.artistIds).toEqual(["b", "a"]);
    expect(cache.albumTracks.get("earlier")?.map((item) => item.id)).toEqual(["first", "second"]);
    expect(cache.albumTracks.get("earlier")).toBe(cache.albumTracks.get("earlier"));
    expect(cache.artistAlbums.get("missing")).toBeUndefined();
    expect(cache.albumTracks.get("missing")).toBeUndefined();
    expect(cache.albumTracks.get("earlier")?.[0]).toBe(cache.tracks.get("first"));
    expect(JSON.parse(await storage.files.get(await snapshotPath(account))!.text())).toEqual(data);
    expect(storage.writes).toBe(0);
  });

  it.each(["artists", "albums", "tracks"] as const)(
    "rejects duplicate IDs in persisted %s",
    async (collection) => {
      const storage = installMetadataStorage();
      const data = snapshot();
      await storage.seed(account, {
        ...data,
        [collection]: [...data[collection], data[collection][0]],
      });
      const cache = new Cache(getAccountKey(account));
      await expect(cache.load()).rejects.toBeInstanceOf(Error);
      expect([...cache.artists.values()]).toEqual([]);
    },
  );

  it("restores library data only from its account's namespace", async () => {
    const storage = installMetadataStorage();
    const other = { ...account, username: "other" };
    await storage.seed(other, snapshot());
    const empty = new Cache(getAccountKey(account));
    await empty.load();
    expect(empty.savedAt).toBeUndefined();
    expect(empty.tracks.size).toBe(0);
    const cache = new Cache(getAccountKey(other));
    await cache.load();
    expect(cache.savedAt).toBe(100);
    expect(cache.tracks.get("song")).toEqual(snapshot().tracks[0]);
  });

  it("restores the whole snapshot without a client or network requests", async () => {
    const storage = installMetadataStorage();
    await storage.seed(account, snapshot());
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    expect([...cache.artists.values()]).toEqual(snapshot().artists);
    expect(cache.albums.get("album")).toEqual(snapshot().albums[0]);
    expect(cache.tracks.get("song")).toEqual(snapshot().tracks[0]);
    expect(cache.artistAlbums.get("artist")).toEqual(snapshot().albums);
    expect(cache.albumTracks.get("album")).toEqual(snapshot().tracks);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports missing or invalid snapshots without touching IndexedDB", async () => {
    const storage = installMetadataStorage();
    const indexedDB = { open: vi.fn() };
    vi.stubGlobal("indexedDB", indexedDB);
    const empty = new Cache(getAccountKey(account));
    await empty.load();
    expect([...empty.artists.values()]).toEqual([]);
    await storage.seed(account, { data: [] });
    const invalid = new Cache(getAccountKey(account));
    await expect(invalid.load()).rejects.toBeInstanceOf(Error);
    expect([...invalid.artists.values()]).toEqual([]);
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
});
