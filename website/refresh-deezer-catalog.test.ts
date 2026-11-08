import { afterEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
// @ts-expect-error The Node-only maintenance script has no TypeScript declaration.
import { refreshArtistArtwork, refreshCatalog } from "./refresh-deezer-catalog.mjs";
import { demoAlbums } from "./deezer-catalog";

vi.mock("node:fs/promises", () => ({ writeFile: vi.fn(async () => {}) }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const photo = "https://cdn-images.dzcdn.net/images/artist/fixture/500x500.jpg";

function albumResponse(album = demoAlbums[0]) {
  return {
    id: album.id,
    title: album.title,
    artist: { id: album.artistId, name: album.artist },
    nb_tracks: album.tracks.length,
    cover_medium: album.artwork,
    release_date: album.sourceReleaseDate,
    tracks: {
      data: album.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        explicit_lyrics: track.explicit,
        artist: { id: album.artistId },
        readable: true,
        preview: "https://cdnt-preview.dzcdn.net/temporary.mp3",
      })),
    },
  };
}

it("retains full album refresh/validation and enriches only after all albums pass", async () => {
  const fetcher = vi.fn(async (input: string) => {
    const id = Number(input.split("/").at(-1));
    return new Response(
      JSON.stringify(
        input.includes("/album/")
          ? albumResponse(demoAlbums.find((album) => album.id === id)!)
          : { id, picture_big: photo },
      ),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await refreshCatalog();
  expect(fetcher).toHaveBeenCalledTimes(69);
  expect(fetcher.mock.calls.slice(0, 53).every(([url]) => url.includes("/album/"))).toBe(true);
  expect(new Set(fetcher.mock.calls.slice(53).map(([url]) => url)).size).toBe(16);
  expect(delay).toHaveBeenCalledTimes(69);
  expect(vi.mocked(delay).mock.calls.every(([ms]) => ms === 200)).toBe(true);
  expect(writeFile).toHaveBeenCalledOnce();
  expect(String(vi.mocked(writeFile).mock.calls[0][0])).toContain("/deezer-catalog.json");
  expect(JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1]))).toEqual(
    demoAlbums.map((album) => ({ ...album, artistArtwork: photo })),
  );
});

it.each([
  "edition",
  "artist",
  "count",
  "date",
  "artwork",
  "recording",
  "duplicate",
  "preview",
  "readable",
])("rejects invalid album %s before fetching photos or writing the catalog", async (failure) => {
  const album = albumResponse();
  if (failure === "edition") album.id = 999;
  if (failure === "artist") album.artist.id = 999;
  if (failure === "count") album.nb_tracks = 999;
  if (failure === "date") album.release_date = "invalid";
  if (failure === "artwork") album.cover_medium = "https://other.test/cover.jpg";
  if (failure === "recording") album.tracks.data[0].artist.id = 999;
  if (failure === "duplicate") album.tracks.data[1].id = album.tracks.data[0].id;
  if (failure === "preview") album.tracks.data[0].preview = "";
  if (failure === "readable") album.tracks.data[0].readable = false;
  const fetcher = vi.fn(async () => new Response(JSON.stringify(album)));
  vi.stubGlobal("fetch", fetcher);
  await expect(refreshCatalog()).rejects.toThrow(/Album 302117/);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(writeFile).not.toHaveBeenCalled();
});

it("fetches once per unique artist, prefers big photos and changes only artistArtwork", async () => {
  const before = structuredClone(demoAlbums);
  const fetcher = vi.fn(
    async (input: string) =>
      new Response(
        JSON.stringify({
          id: Number(input.split("/").at(-1)),
          picture_big: photo,
          picture_medium: `${photo}?medium`,
          preview: "not-to-be-persisted",
          name: "Unrelated live metadata drift",
        }),
      ),
  );
  const result = await refreshArtistArtwork(demoAlbums, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(16);
  expect(new Set(fetcher.mock.calls.map(([url]) => url)).size).toBe(16);
  expect(result).toEqual(before.map((album) => ({ ...album, artistArtwork: photo })));
  expect(demoAlbums).toEqual(before);
  for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(call[0]).toMatch(/^https:\/\/api\.deezer\.com\/artist\/\d+$/);
    expect(call[1]).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  }
});

it("uses picture_medium if picture_big is absent", async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ id: 702, picture_medium: photo })),
  );
  expect((await refreshArtistArtwork([demoAlbums[0]], fetcher))[0].artistArtwork).toBe(photo);
});

it.each([
  {},
  { picture_big: "bad" },
  { picture_big: "/relative" },
  { picture_big: "http://cdn-images.dzcdn.net/photo.jpg" },
  { picture_big: "https://other.test/photo.jpg" },
  { picture_big: "https://user:secret@cdn-images.dzcdn.net/photo.jpg" },
  { picture_big: "https://cdn-images.dzcdn.net.evil.test/photo.jpg" },
  { picture_big: "bad", picture_medium: photo },
])("rejects missing or unsafe photos rather than substituting album art: %j", async (fields) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 702, ...fields })));
  await expect(refreshArtistArtwork([demoAlbums[0]], fetcher)).rejects.toThrow(/photo URL/);
});

it("rejects mismatched artist identity and HTTP failures", async () => {
  await expect(
    refreshArtistArtwork(
      [demoAlbums[0]],
      async () =>
        new Response(
          JSON.stringify({
            id: 999,
            picture_big: photo,
          }),
        ),
    ),
  ).rejects.toThrow("mismatched artist");
  await expect(
    refreshArtistArtwork([demoAlbums[0]], async () => new Response("", { status: 503 })),
  ).rejects.toThrow("HTTP 503");
});
