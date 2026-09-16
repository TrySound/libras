import { afterEach, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { account, installMetadataStorage, snapshotPath } from "./library-test-helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { album: "album-art", track: "track-art" },
  { album: "album-art", track: undefined },
  { album: undefined, track: undefined },
])(
  "preserves stored artwork IDs on load and replacement: $album / $track",
  async ({ album, track }) => {
    const storage = installMetadataStorage();
    await storage.seed(account, {
      savedAt: 100,
      lastModified: 90,
      artists: [
        { id: "artist", name: "Artist", artworkId: "artist-art", genres: [] },
        { id: "guest", name: "Guest", artworkId: "guest-art", genres: [] },
      ],
      albums: [{ id: "album", title: "Album", artistId: "artist", artworkId: album, genres: [] }],
      tracks: [
        {
          id: "track",
          title: "Track",
          albumId: "album",
          artistId: "guest",
          artworkId: track,
          genres: [],
        },
      ],
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    expect(cache.albums.get("album")?.artworkId).toBe(album);
    expect(cache.tracks.get("track")?.artworkId).toBe(track);
    expect(cache.savedAt).toBe(100);
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.writes).toBe(0);
    await cache.replaceLibrary({
      savedAt: 101,
      lastModified: 90,
      artists: [...cache.artists.values()],
      albums: [...cache.albums.values()],
      tracks: [...cache.tracks.values()],
    });
    await cache.flush();
    const persisted = JSON.parse(await storage.files.get(await snapshotPath(account))!.text());
    expect(persisted.tracks[0].artworkId).toBe(track);
    expect(persisted.albums[0].artworkId).toBe(album);
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(restored.tracks.get("track")?.artworkId).toBe(track);
  },
);

it("does not borrow artwork from a track artist when its album is missing", async () => {
  const storage = installMetadataStorage();
  await storage.seed(account, {
    savedAt: 100,
    lastModified: 90,
    artists: [{ id: "artist", name: "Artist", artworkId: "artist-art", genres: [] }],
    albums: [],
    tracks: [{ id: "track", title: "Track", albumId: "missing", artistId: "artist", genres: [] }],
  });
  const cache = new Cache(getAccountKey(account));
  await cache.load();
  expect(cache.tracks.get("track")?.artworkId).toBeUndefined();
});
