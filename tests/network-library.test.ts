import { afterEach, describe, expect, it, vi } from "vitest";
import { Network } from "../src/network.svelte";
import { Cache } from "../src/cache.svelte";
import { getAccountKey } from "../src/auth";
import { createSearchIndex, searchLibrary } from "../src/_search.svelte";
import { installMetadataStorage } from "./library-test-helpers";

const account = { host: "https://music.example.com", username: "listener" };
const auth = {
  ...account,
  credentials: {
    method: "token" as const,
    username: account.username,
    token: "token",
    salt: "salt",
  },
};
function createConnection(credentials = auth) {
  const network = new Network();
  const client = network.prepare(credentials);
  network.accept(client);
  return {
    ...client.metadata,
    abort: () => network.setMode("offline"),
  };
}
function response(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}
function serveLibrary(data: { artists?: unknown[]; albums?: unknown[]; tracks?: unknown[] } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("getIndexes")) return response({ indexes: { lastModified: 20 } });
    if (url.includes("search3")) {
      const params = new URL(url).searchParams;
      const slice = (key: string, items: unknown[]) =>
        items.slice(
          Number(params.get(`${key}Offset`)),
          Number(params.get(`${key}Offset`)) + Number(params.get(`${key}Count`)),
        );
      return response({
        searchResult3: {
          artist: slice("artist", data.artists ?? [{ id: "artist", name: "Artist" }]),
          album: slice(
            "album",
            data.albums ?? [
              { id: "album", name: "Album", artists: [{ id: "artist", name: "Artist" }] },
            ],
          ),
          song: slice(
            "song",
            data.tracks ?? [
              {
                id: "song",
                title: "Song",
                artists: [{ id: "artist", name: "Artist" }],
                albumId: "album",
                track: 1,
                contentType: "audio/flac",
              },
            ],
          ),
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("network library", () => {
  it.each([false, true])(
    "retains singles in a mixed/singles-only catalog (only=%s)",
    async (only) => {
      vi.stubGlobal(
        "fetch",
        serveLibrary({
          artists: [{ id: "artist", name: "Artist", coverArt: "artist-art" }],
          albums: only ? [] : undefined,
          tracks: [
            ...(!only ? [{ id: "song", title: "Album song", albumId: "album" }] : []),
            {
              id: "single",
              title: "Standalone",
              artists: [{ id: "artist", name: "Artist" }],
              displayArtist: "Artist solo",
              coverArt: "single-art",
              track: 3,
              discNumber: 2,
              duration: 123,
              contentType: "audio/flac",
              genres: [{ name: "Jazz" }, { name: "Jazz" }],
            },
            {
              id: "fallback",
              title: "Fallback",
              albumId: "",
              artists: [{ id: "artist", name: "Artist" }],
              displayArtist: "Artist solo",
            },
            { id: "display", title: "Display only", displayArtist: "Guest & friends" },
            { id: "unknown", title: "Unknown" },
          ],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.tracks.map((track) => track.id)).toEqual([
        ...(!only ? ["song"] : []),
        "single",
        "fallback",
        "display",
        "unknown",
      ]);
      const single = library.tracks.find((track) => track.id === "single")!;
      const fallback = library.tracks.find((track) => track.id === "fallback")!;
      expect(single).toMatchObject({
        id: "single",
        title: "Standalone",
        artistIds: ["artist"],
        displayArtist: "Artist solo",
        artworkId: "single-art",
        number: 3,
        disc: 2,
        duration: 123,
        mimeType: "audio/flac",
        genres: ["Jazz", "Jazz"],
      });
      expect(single.albumId).toMatch(/^local:singles:/);
      expect(fallback).toMatchObject({ albumId: single.albumId, artworkId: "artist-art" });
      expect(library.albums.find((album) => album.id === single.albumId)).toMatchObject({
        title: "Singles",
        artistIds: ["artist"],
        displayArtist: "Artist solo",
        artworkId: "artist-art",
      });
      expect(library.tracks.find((track) => track.id === "display")).toMatchObject({
        artistIds: ["local:artist:Guest%20%26%20friends"],
        displayArtist: "Guest & friends",
      });
      expect(library.tracks.find((track) => track.id === "unknown")).toMatchObject({
        artistIds: ["local:artist:Unknown%20artist"],
        displayArtist: "Unknown artist",
      });
      expect(await connection.readLibrary(connection.signal)).toEqual(library);
      connection.abort();
    },
  );

  it("collects a single on a later song page after artists and albums finish", async () => {
    const songOffsets: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const params = new URL(String(input)).searchParams;
        const offset = Number(params.get("songOffset"));
        songOffsets.push(offset);
        return response({
          searchResult3: {
            artist: [],
            album: params.get("albumOffset") === "0" ? [{ id: "album", name: "Album" }] : [],
            song:
              offset < 3
                ? [
                    {
                      id: offset === 2 ? "single" : `song-${offset}`,
                      title: `Song ${offset}`,
                      albumId: offset === 2 ? undefined : "album",
                      displayArtist: "Solo",
                    },
                  ]
                : [],
          },
        });
      }),
    );
    const connection = createConnection();
    const library = await connection.readLibrary(connection.signal);
    expect(songOffsets).toEqual([0, 1, 2, 3]);
    expect(library.albums).toHaveLength(2);
    expect(library.tracks.map((track) => track.id)).toEqual(["song-0", "song-1", "single"]);
    expect(library.tracks[2].albumId).toMatch(/^local:singles:/);
    connection.abort();
  });

  it("rejects a nonempty dangling album even alongside singles", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        tracks: [
          { id: "single", title: "Single" },
          { id: "bad", title: "Bad", albumId: "missing" },
        ],
      }),
    );
    const connection = createConnection();
    await expect(connection.readLibrary(connection.signal)).rejects.toThrow(
      "without a matching album",
    );
    connection.abort();
  });

  it("does not merge local collections with colliding server album IDs", async () => {
    const data = {
      artists: [],
      albums: [] as { id: string; name: string }[],
      tracks: [{ id: "single", title: "Single", displayArtist: "Solo" }],
    };
    vi.stubGlobal("fetch", serveLibrary(data));
    const connection = createConnection();
    const first = await connection.readLibrary(connection.signal);
    const id = first.albums[0].id;
    data.albums.push({ id, name: "Real server album" });
    const next = await connection.readLibrary(connection.signal);
    expect(next.albums).toHaveLength(2);
    expect(next.albums.find((album) => album.id === id)?.title).toBe("Real server album");
    expect(next.tracks[0].albumId).not.toBe(id);
    expect(next.tracks[0].id).toBe("single");
    connection.abort();
  });

  it("persists searchable singles offline and removes stale groups on refresh", async () => {
    installMetadataStorage();
    const data = {
      albums: [],
      tracks: [{ id: "single", title: "Standalone", displayArtist: "Solo", coverArt: "cover" }],
    };
    vi.stubGlobal("fetch", serveLibrary(data));
    const connection = createConnection();
    const cache = new Cache(getAccountKey(account));
    await cache.load();
    await cache.replaceLibrary({
      ...(await connection.readLibrary(connection.signal)),
      savedAt: 1,
      lastModified: null,
    });
    const albumId = cache.tracks.get("single")!.albumId;
    await cache.flush();
    const restored = new Cache(getAccountKey(account));
    await restored.load();
    expect(restored.albumTracks.get(albumId)?.map((track) => track.id)).toEqual(["single"]);
    expect(restored.artistAlbums.get("local:artist:Solo")?.map((album) => album.id)).toEqual([
      albumId,
    ]);
    const index = createSearchIndex(
      restored.artists,
      restored.albums,
      restored.tracks,
      (id) => id === "single",
    );
    expect(searchLibrary(index, "Standalone").groups[2].records[0]).toMatchObject({
      id: "single",
      artworkId: "cover",
      artist: "Solo",
      album: "Singles",
    });
    data.tracks = [];
    await restored.replaceLibrary({
      ...(await connection.readLibrary(connection.signal)),
      savedAt: 2,
      lastModified: null,
    });
    expect(restored.tracks.size).toBe(0);
    expect(restored.albums.size).toBe(0);
    expect(restored.artistAlbums.size).toBe(0);
    await restored.flush();
    const removed = new Cache(getAccountKey(account));
    await removed.load();
    expect(removed.tracks.size).toBe(0);
    connection.abort();
  });

  it.each([
    {
      artist: "artist-art",
      album: "album-art",
      track: "track-art",
      expectedAlbum: "album-art",
      expectedTrack: "track-art",
    },
    {
      artist: "artist-art",
      album: "album-art",
      track: undefined,
      expectedAlbum: "album-art",
      expectedTrack: "album-art",
    },
    {
      artist: "artist-art",
      album: undefined,
      track: undefined,
      expectedAlbum: "artist-art",
      expectedTrack: "artist-art",
    },
    {
      artist: undefined,
      album: undefined,
      track: undefined,
      expectedAlbum: undefined,
      expectedTrack: undefined,
    },
  ])(
    "materializes effective artwork IDs: $expectedAlbum / $expectedTrack",
    async ({ artist, album, track, expectedAlbum, expectedTrack }) => {
      vi.stubGlobal(
        "fetch",
        serveLibrary({
          artists: [
            { id: "artist", name: "Artist", coverArt: artist },
            { id: "guest", name: "Guest", coverArt: "guest-art" },
          ],
          albums: [
            {
              id: "album",
              name: "Album",
              artists: [{ id: "artist", name: "Artist" }],
              coverArt: album,
            },
          ],
          tracks: [
            {
              id: "song",
              title: "Song",
              albumId: "album",
              artists: [{ id: "guest", name: "Guest" }],
              coverArt: track,
            },
          ],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.albums[0].artworkId).toBe(expectedAlbum);
      expect(library.tracks[0].artworkId).toBe(expectedTrack);
      expect(library.tracks[0].artistIds).toEqual(["guest"]);
      connection.abort();
    },
  );

  it("recomputes inherited IDs from fresh server metadata on every refresh", async () => {
    const artists = [{ id: "artist", name: "Artist", coverArt: "first" }];
    vi.stubGlobal("fetch", serveLibrary({ artists }));
    const connection = createConnection();
    const first = await connection.readLibrary(connection.signal);
    expect(first.tracks[0].artworkId).toBe("first");
    artists[0].coverArt = "second";
    const second = await connection.readLibrary(connection.signal);
    expect(second.albums[0].artworkId).toBe("second");
    expect(second.tracks[0].artworkId).toBe("second");
    artists[0].coverArt = "";
    const third = await connection.readLibrary(connection.signal);
    expect(third.albums[0].artworkId).toBeUndefined();
    expect(third.tracks[0].artworkId).toBeUndefined();
    connection.abort();
  });

  it("paginates all metadata independently through search3", async () => {
    const albums = Array.from({ length: 501 }, (_, index) => ({
      id: `album-${index}`,
      name: `Album ${index}`,
      artists: [{ id: "artist", name: "Artist" }],
    }));
    const offsets: number[] = [];
    const artistCounts: number[] = [];
    const songOffsets: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("u")).toBe(auth.username);
        if (url.pathname.endsWith("getIndexes.view"))
          return response({ indexes: { lastModified: 20 } });
        if (url.pathname.endsWith("search3.view")) {
          expect(url.searchParams.get("query")).toBe("");
          const offset = Number(url.searchParams.get("albumOffset"));
          offsets.push(offset);
          artistCounts.push(Number(url.searchParams.get("artistCount")));
          songOffsets.push(Number(url.searchParams.get("songOffset")));
          return response({
            searchResult3: {
              artist:
                Number(url.searchParams.get("artistOffset")) === 0
                  ? [{ id: "artist", name: "Artist" }]
                  : [],
              album: albums.slice(offset, offset + 500),
              song: [],
            },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const connection = createConnection();
    const library = await connection.readLibrary(connection.signal);
    expect(offsets).toEqual([0, 500, 501]);
    expect(artistCounts).toEqual([500, 500, 0]);
    expect(songOffsets).toEqual([0, 0, 0]);
    expect(library.albums.length).toBe(501);

    connection.abort();
  });

  it("normalizes all referenced artists while preserving track display credits", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [
          { id: "artist", name: "Artist", genre: " Rock | jazz ", genres: [{ name: "rock" }] },
          { id: "guest", name: "Guest" },
          { id: "unused", name: "Unused contributor" },
        ],
        albums: [
          {
            id: "album",
            name: "Album",
            artists: [{ id: "artist", name: "Artist" }],
            coverArt: "cover",
            year: 2024,
          },
        ],
        tracks: [
          {
            id: "second",
            title: "Second",
            artists: [{ id: "guest", name: "Guest" }],
            albumId: "album",
            track: 2,
            discNumber: 1,
            contentType: "audio/flac",
            duration: 120,
          },
          { id: "first", title: "First", albumId: "album", track: 1 },
        ],
      }),
    );
    const connection = createConnection();
    const library = await connection.readLibrary(connection.signal);
    expect(library.albums.find((album) => album.id === "album")).toEqual({
      id: "album",
      title: "Album",
      artistIds: ["artist"],
      displayArtist: "Artist",
      artworkId: "cover",
      year: 2024,
      genres: [],
    });
    expect(library.tracks.find((track) => track.id === "second")).toMatchObject({
      artistIds: ["guest"],
      displayArtist: "Guest",
      albumId: "album",
      number: 2,
      disc: 1,
      mimeType: "audio/flac",
      duration: 120,
    });
    expect(library.tracks.find((track) => track.id === "first")?.artistIds).toEqual(["artist"]);
    expect(library.artists.find((artist) => artist.id === "artist")).not.toHaveProperty("genres");
    expect(library.artists.map((artist) => artist.id)).toEqual(["artist", "guest"]);
    expect(library.artists[0]).not.toHaveProperty("albums");
    expect(library.albums[0]).not.toHaveProperty("tracks");
    expect(JSON.stringify(library)).not.toMatch(/contentType|coverArt|discNumber/);
    connection.abort();
  });

  it.each([
    {
      genres: [{ name: "Rock" }, { name: "rock" }, { name: "Jazz|Fusion" }],
      expected: ["Rock", "rock", "Jazz|Fusion"],
    },
    { genres: [], expected: [] },
    { genres: undefined, expected: [] },
  ])(
    "normalizes structured genres without legacy fallbacks: $genres",
    async ({ genres, expected }) => {
      vi.stubGlobal(
        "fetch",
        serveLibrary({
          artists: [
            { id: "artist", name: "Artist", genre: "Ignored", genres: [{ name: "Ignored" }] },
          ],
          albums: [
            {
              id: "album",
              name: "Album",
              artists: [{ id: "artist", name: "Artist" }],
              genre: "Legacy|Genre",
              genres,
            },
          ],
          tracks: [{ id: "song", title: "Song", albumId: "album", genre: "Legacy|Genre", genres }],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.artists[0]).not.toHaveProperty("genres");
      expect(library.albums[0].genres).toEqual(expected);
      expect(library.tracks[0].genres).toEqual(expected);
      connection.abort();
    },
  );

  it.each([
    { displayArtist: "Lead feat. Guest", expected: "Lead feat. Guest" },
    { displayArtist: undefined, expected: "Lead, Guest" },
  ])(
    "preserves structured credits with displayArtist=$displayArtist",
    async ({ displayArtist, expected }) => {
      vi.stubGlobal(
        "fetch",
        serveLibrary({
          artists: [{ id: "owner", name: "Owner" }],
          albums: [
            {
              id: "album",
              name: "Album",
              artists: [
                { id: "owner", name: "Owner" },
                { id: "other", name: "Other" },
              ],
              displayArtist: "Owner & Other",
              artistId: "legacy",
              artist: "Legacy",
            },
          ],
          tracks: [
            {
              id: "song",
              title: "Song",
              albumId: "album",
              artists: [
                { id: "lead", name: "Lead" },
                { id: "guest", name: "Guest" },
              ],
              displayArtist,
              artistId: "legacy",
              artist: "Legacy",
            },
          ],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.albums[0].artistIds).toEqual(["owner", "other"]);
      expect(library.albums[0].displayArtist).toBe("Owner & Other");
      expect(library.tracks[0]).toMatchObject({
        artistIds: ["lead", "guest"],
        displayArtist: expected,
      });
      expect(library.albums[0]).not.toHaveProperty("artistId");
      expect(library.tracks[0]).not.toHaveProperty("artistId");
      expect(library.tracks[0]).not.toHaveProperty("artistName");
      expect(library.tracks[0]).not.toHaveProperty("artists");
      expect(library.artists).toEqual([
        { id: "owner", name: "Owner" },
        { id: "other", name: "Other" },
        { id: "lead", name: "Lead" },
        { id: "guest", name: "Guest" },
      ]);
      connection.abort();
    },
  );

  it.each([undefined, []])(
    "does not recover legacy-only artist credits when artists=%j",
    async (artists) => {
      vi.stubGlobal(
        "fetch",
        serveLibrary({
          artists: [],
          albums: [{ id: "album", name: "Album", artists, artistId: "legacy", artist: "Legacy" }],
          tracks: [
            {
              id: "song",
              title: "Song",
              albumId: "album",
              artists,
              artistId: "legacy",
              artist: "Legacy",
            },
          ],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.artists[0]).toMatchObject({
        id: "local:artist:Unknown%20artist",
        name: "Unknown artist",
      });
      expect(library.albums[0].artistIds).toEqual([library.artists[0].id]);
      expect(library.tracks[0]).toMatchObject({
        artistIds: [library.artists[0].id],
        displayArtist: "Unknown artist",
      });
      connection.abort();
    },
  );

  it("keeps artists who own later albums and removes unreferenced search artists", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [
          { id: "unused", name: "Unused" },
          { id: "guest", name: "Guest" },
        ],
        albums: [
          { id: "first", name: "First", artists: [{ id: "owner", name: "Owner" }] },
          { id: "second", name: "Second", artists: [{ id: "guest", name: "Guest" }] },
        ],
        tracks: [
          {
            id: "song",
            title: "Song",
            albumId: "first",
            artists: [{ id: "guest", name: "Guest" }],
          },
        ],
      }),
    );
    const connection = createConnection(auth);
    const library = await connection.readLibrary(new AbortController().signal);
    expect(library.artists.map((artist) => artist.id).sort()).toEqual(["guest", "owner"]);
    expect(library.tracks[0]).toMatchObject({ artistIds: ["guest"], displayArtist: "Guest" });
    vi.stubGlobal(
      "fetch",
      serveLibrary({ artists: [{ id: "unused", name: "Unused" }], albums: [], tracks: [] }),
    );
    await expect(connection.readLibrary(new AbortController().signal)).resolves.toEqual({
      artists: [],
      albums: [],
      tracks: [],
    });
    connection.abort();
  });

  it("inherits all album credits when a track has none", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [],
        albums: [
          {
            id: "album",
            name: "Album",
            artists: [
              { id: "a", name: "Alpha" },
              { id: "b", name: "Beta" },
            ],
          },
        ],
        tracks: [{ id: "song", title: "Song", albumId: "album" }],
      }),
    );
    const connection = createConnection();
    const library = await connection.readLibrary(connection.signal);
    expect(library.tracks[0]).toMatchObject({
      artistIds: ["a", "b"],
      displayArtist: "Alpha, Beta",
    });
    expect(library.artists).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    connection.abort();
  });

  it("creates stable IDs when only display artists are supplied", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [],
        albums: [{ id: "album", name: "Album", displayArtist: "Artist" }],
        tracks: [{ id: "song", title: "Song", albumId: "album", displayArtist: "Guest" }],
      }),
    );
    const connection = createConnection();
    const library = await connection.readLibrary(connection.signal);
    const ids = library.artists.map((artist) => artist.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(library.albums.find((album) => album.id === "album")?.artistIds[0]);
    expect(ids).toContain(library.tracks.find((track) => track.id === "song")?.artistIds[0]);
    expect(library.tracks.find((track) => track.id === "song")?.displayArtist).toBe("Guest");
    const refreshed = await connection.readLibrary(connection.signal);
    expect(refreshed.artists.map((artist) => artist.id)).toEqual(ids);
    connection.abort();
  });
});
