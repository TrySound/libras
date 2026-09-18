import { afterEach, describe, expect, it, vi } from "vitest";
import { Network } from "../src/network.svelte";

const account = { host: "https://music.example.com", username: "listener" };
const auth = { ...account, token: "token", salt: "salt" };
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
            data.albums ?? [{ id: "album", name: "Album", artistId: "artist" }],
          ),
          song: slice(
            "song",
            data.tracks ?? [
              {
                id: "song",
                title: "Song",
                artistId: "artist",
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
          albums: [{ id: "album", name: "Album", artistId: "artist", coverArt: album }],
          tracks: [
            { id: "song", title: "Song", albumId: "album", artistId: "guest", coverArt: track },
          ],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.albums[0].artworkId).toBe(expectedAlbum);
      expect(library.tracks[0].artworkId).toBe(expectedTrack);
      expect(library.tracks[0].artistId).toBe("guest");
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
      artistId: "artist",
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

  it("normalizes only album artists while preserving track artist names", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [
          { id: "artist", name: "Artist", genre: " Rock | jazz ", genres: [{ name: "rock" }] },
          { id: "guest", name: "Guest" },
          { id: "unused", name: "Unused contributor" },
        ],
        albums: [{ id: "album", name: "Album", artistId: "artist", coverArt: "cover", year: 2024 }],
        tracks: [
          {
            id: "second",
            title: "Second",
            artistId: "guest",
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
      artistId: "artist",
      artworkId: "cover",
      year: 2024,
      genres: [],
    });
    expect(library.tracks.find((track) => track.id === "second")).toMatchObject({
      artistId: "guest",
      artistName: "Guest",
      albumId: "album",
      number: 2,
      disc: 1,
      mimeType: "audio/flac",
      duration: 120,
    });
    expect(library.tracks.find((track) => track.id === "first")?.artistId).toBe("artist");
    expect(
      library.artists
        .find((artist) => artist.id === "artist")
        ?.genres.map((genre) => genre.toLowerCase()),
    ).toEqual([]);
    expect(library.artists.map((artist) => artist.id)).toEqual(["artist"]);
    expect(library.artists[0]).not.toHaveProperty("albums");
    expect(library.albums[0]).not.toHaveProperty("tracks");
    expect(JSON.stringify(library)).not.toMatch(/contentType|coverArt|discNumber/);
    connection.abort();
  });

  it.each([
    {
      genres: [{ name: " Rock " }, { name: "rock" }, { name: "Jazz|Fusion" }, { name: " " }],
      expected: ["Jazz|Fusion", "rock"],
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
            { id: "album", name: "Album", artistId: "artist", genre: "Legacy|Genre", genres },
          ],
          tracks: [{ id: "song", title: "Song", albumId: "album", genre: "Legacy|Genre", genres }],
        }),
      );
      const connection = createConnection();
      const library = await connection.readLibrary(connection.signal);
      expect(library.artists[0].genres).toEqual([]);
      expect(library.albums[0].genres).toEqual(expected);
      expect(library.tracks[0].genres).toEqual(expected);
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
          { id: "first", name: "First", artistId: "owner", artist: "Owner" },
          { id: "second", name: "Second", artistId: "guest", artist: "Guest" },
        ],
        tracks: [{ id: "song", title: "Song", albumId: "first", artistId: "guest" }],
      }),
    );
    const connection = createConnection(auth);
    const library = await connection.readLibrary(new AbortController().signal);
    expect(library.artists.map((artist) => artist.id).sort()).toEqual(["guest", "owner"]);
    expect(library.tracks[0]).toMatchObject({ artistId: "guest", artistName: "Guest" });
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

  it("creates stable IDs for artists missing server IDs", async () => {
    vi.stubGlobal(
      "fetch",
      serveLibrary({
        artists: [{ name: "Artist" }],
        albums: [{ id: "album", name: "Album", artist: "Artist" }],
        tracks: [{ id: "song", title: "Song", albumId: "album", artist: "Guest" }],
      }),
    );
    const connection = createConnection();
    const library = await connection.readLibrary(connection.signal);
    const ids = library.artists.map((artist) => artist.id);
    expect(ids).toHaveLength(1);
    expect(ids).toContain(library.albums.find((album) => album.id === "album")?.artistId);
    expect(ids).not.toContain(library.tracks.find((track) => track.id === "song")?.artistId);
    expect(library.tracks.find((track) => track.id === "song")?.artistName).toBe("Guest");
    const refreshed = await connection.readLibrary(connection.signal);
    expect(refreshed.artists.map((artist) => artist.id)).toEqual(ids);
    connection.abort();
  });
});
