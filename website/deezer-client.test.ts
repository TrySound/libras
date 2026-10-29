// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { DeezerSubsonicClient } from "./deezer-client";
import {
  deezerAlbumFixture as album,
  archiveAlbumFixture,
  additionalAlbumFixtures,
  readAlbumFixture,
} from "./deezer-fixtures";
import { Network } from "../src/network.svelte";

const auth = {
  host: "https://example.test",
  username: "deezer-preview-demo",
  token: "local",
  salt: "local",
};
const pagination = {
  artistCount: 10,
  artistOffset: 0,
  albumCount: 10,
  albumOffset: 0,
  songCount: 100,
  songOffset: 0,
};

it("loads five artists and 49 selected recordings without persisting preview URLs or original durations", async () => {
  const read = vi.fn(readAlbumFixture);
  const client = new DeezerSubsonicClient(auth, read);
  await client.ping();
  const result = await client.search3(pagination);
  expect(result.artists.map((artist) => artist.name)).toEqual([
    "A Perfect Circle",
    "Archive",
    "Metric",
    "Radiohead",
    "The xx",
  ]);
  expect(result.albums.map((album) => ({ id: album.id, year: album.year }))).toEqual([
    { id: "302117", year: 2000 },
    { id: "59667692", year: 2009 },
    { id: "320369597", year: 2009 },
    { id: "14879699", year: 1997 },
    { id: "355921", year: 2009 },
  ]);
  expect(result.tracks).toHaveLength(49);
  expect(result.tracks.slice(0, 3).map((track) => track.id)).toEqual([
    "3135439",
    "3135442",
    "3135444",
  ]);
  expect(result.tracks.slice(3, 16).map((track) => track.id)).toEqual(
    archiveAlbumFixture.tracks.data.map((track) => String(track.id)),
  );
  expect(result.tracks[4]).toMatchObject({
    title: "Bullets — Preview",
    albumId: "59667692",
    track: 2,
  });
  expect(result.tracks[12].title).toContain("Explicit");
  expect(client.getCoverArtUrl("302117")).toBe(album.cover_medium);
  expect(client.getCoverArtUrl("59667692")).toBe(archiveAlbumFixture.cover_medium);
  for (const fixture of additionalAlbumFixtures) {
    expect(client.getCoverArtUrl(String(fixture.id))).toBe(fixture.cover_medium);
    expect(
      result.tracks
        .filter((track) => track.albumId === String(fixture.id))
        .map((track) => track.id),
    ).toEqual(fixture.tracks.data.map((track) => String(track.id)));
  }
  expect(result.tracks[18].title).toContain("Explicit");
  expect(result.tracks[1].title).toContain("Explicit");
  expect(JSON.stringify(result)).not.toContain("temporary");
  expect(result.tracks[0]).not.toHaveProperty("duration");
  expect((await client.search3({ ...pagination, songOffset: 1, songCount: 1 })).tracks[0].id).toBe(
    "3135442",
  );
  expect(read).toHaveBeenCalledTimes(5);
  const page = await client.search3({
    ...pagination,
    artistOffset: 1,
    artistCount: 1,
    albumOffset: 1,
    albumCount: 1,
    songOffset: 2,
    songCount: 3,
  });
  expect(page.artists.map((artist) => artist.id)).toEqual(["1334"]);
  expect(page.albums.map((album) => album.id)).toEqual(["59667692"]);
  expect(page.tracks.map((track) => track.id)).toEqual(["3135444", "476972622", "476972632"]);
});

it("uses original release years rather than Deezer edition dates", async () => {
  const read = vi.fn(async (path: string) => ({
    ...(await readAlbumFixture(path)),
    release_date: "2026-01-01",
  }));
  const client = new DeezerSubsonicClient(auth, read);
  expect((await client.search3(pagination)).albums.map((album) => album.year)).toEqual([
    2000, 2009, 2009, 1997, 2009,
  ]);
});

it("does not require playback fields to browse the albums", async () => {
  const read = vi.fn(async (path: string) => {
    const album = await readAlbumFixture(path);
    return {
      ...album,
      tracks: {
        data: album.tracks.data.map(({ id, title, explicit_lyrics, artist }) => ({
          id,
          title,
          explicit_lyrics,
          artist,
        })),
      },
    };
  });
  const client = new DeezerSubsonicClient(auth, read);
  expect((await client.search3(pagination)).tracks).toHaveLength(49);
});

it.each(additionalAlbumFixtures)("resolves a preview for $artist.name", async (fixture) => {
  const track = fixture.tracks.data[0];
  const read = vi.fn().mockResolvedValue({ ...track, album: { id: fixture.id } });
  const client = new DeezerSubsonicClient(auth, read);
  expect(await client.getStreamUrl(String(track.id))).toContain("fixture.mp3");
  expect(read).toHaveBeenCalledWith(`track/${track.id}`, expect.any(AbortSignal));
});

it("resolves a new preview for each playback and honors cancellation", async () => {
  const read = vi.fn().mockImplementation(async () => ({
    ...album.tracks.data[0],
    album: { id: 302117 },
    preview: `https://cdnt-preview.dzcdn.net/clip.mp3?request=${read.mock.calls.length}`,
  }));
  const client = new DeezerSubsonicClient(auth, read);
  expect(await client.getStreamUrl("3135439")).toContain("request=1");
  expect(await client.getStreamUrl("3135439")).toContain("request=2");
  const controller = new AbortController();
  read.mockImplementation(async () => {
    controller.abort();
    return { ...album.tracks.data[0], album: { id: 302117 } };
  });
  await expect(client.getStreamUrl("3135439", {}, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

it("rejects unavailable recordings, unknown IDs and external media origins", async () => {
  const read = vi
    .fn()
    .mockResolvedValue({ ...album.tracks.data[0], album: { id: 302117 }, readable: false });
  const client = new DeezerSubsonicClient(auth, read);
  await expect(client.getStreamUrl("3135439")).rejects.toThrow("unavailable");
  await expect(client.getStreamUrl("999")).rejects.toThrow("Unknown");
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({
    ...album.tracks.data[0],
    album: { id: 302117 },
    preview: "https://cdnt-preview.dzcdn.net.evil.test/clip.mp3",
  });
  await expect(client.getStreamUrl("3135439")).rejects.toThrow("Unexpected");
});

it("retries failed catalog loads and rejects stale responses after disconnect", async () => {
  const read = vi.fn(readAlbumFixture).mockRejectedValueOnce(new Error("offline"));
  const client = new DeezerSubsonicClient(auth, read);
  await expect(client.ping()).rejects.toThrow("offline");
  await expect(client.ping()).resolves.toMatchObject({ openSubsonic: true });
  const stale = new DeezerSubsonicClient(auth, async () => {
    stale.abort();
    return album;
  });
  await expect(stale.ping()).rejects.toMatchObject({ name: "AbortError" });
});

it("resolves Bullets only for the selected Archive album and artist", async () => {
  const read = vi
    .fn()
    .mockResolvedValue({ ...archiveAlbumFixture.tracks.data[1], album: { id: 59667692 } });
  const client = new DeezerSubsonicClient(auth, read);
  expect(await client.getStreamUrl("476972632")).toContain("archive-example.mp3");
  expect(read).toHaveBeenCalledWith("track/476972632", expect.any(AbortSignal));
  read.mockResolvedValue({ ...archiveAlbumFixture.tracks.data[1], album: { id: 302117 } });
  await expect(client.getStreamUrl("476972632")).rejects.toThrow();
});

it("rejects missing recordings and mismatched artists", async () => {
  const read = vi.fn(async (path: string) => {
    const input = await readAlbumFixture(path);
    return path === "album/59667692" ? { ...input, artist: album.artist } : input;
  });
  await expect(new DeezerSubsonicClient(auth, read).ping()).rejects.toThrow("Unexpected");
  read.mockImplementation(async (path) => {
    const input = await readAlbumFixture(path);
    return { ...input, tracks: { data: [] } };
  });
  await expect(new DeezerSubsonicClient(auth, read).ping()).rejects.toThrow("missing");
});

it("supports async playback URLs through Network", async () => {
  const read = vi.fn().mockResolvedValue({ ...album.tracks.data[0], album: { id: 302117 } });
  const network = new Network((identity) => new DeezerSubsonicClient(identity, read));
  const connection = network.accept(network.prepare(auth));
  expect(await connection.audio.url("3135439", { format: "raw" })).toContain(
    "https://cdnt-preview.dzcdn.net/",
  );
  network.setMode("offline");
});
