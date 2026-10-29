// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { DeezerSubsonicClient } from "./deezer-client";
import {
  albumFixtures,
  deezerAlbumFixture as album,
  archiveAlbumFixture,
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
  artistCount: 100,
  artistOffset: 0,
  albumCount: 100,
  albumOffset: 0,
  songCount: 1000,
  songOffset: 0,
};

it("loads 14 unique artists, 47 editions and 571 recordings without persisting preview URLs or song durations", async () => {
  const read = vi.fn(readAlbumFixture);
  const client = new DeezerSubsonicClient(auth, read);
  await client.ping();
  const result = await client.search3(pagination);
  expect(result.artists.map((artist) => artist.name)).toEqual([
    "A Perfect Circle",
    "Archive",
    "Arctic Monkeys",
    "Audioslave",
    "Foo Fighters",
    "Metric",
    "Nothing But Thieves",
    "Poets of the Fall",
    "Queens of the Stone Age",
    "Radiohead",
    "Röyksopp",
    "Soundgarden",
    "The xx",
    "TOOL",
  ]);
  expect(result.albums).toHaveLength(47);
  expect(result.tracks).toHaveLength(571);
  expect(new Set(result.tracks.map((track) => track.id)).size).toBe(571);
  for (const fixture of albumFixtures) {
    expect(client.getCoverArtUrl(String(fixture.id))).toBe(fixture.cover_medium);
    expect(
      result.tracks
        .filter((track) => track.albumId === String(fixture.id))
        .map((track) => track.id),
    ).toEqual(fixture.tracks.data.map((track) => String(track.id)));
  }
  expect(result.tracks.find((track) => track.id === "476972632")).toMatchObject({
    title: "Bullets — Preview",
    albumId: "59667692",
    track: 2,
  });
  expect(result.tracks.find((track) => track.id === "3135442")?.title).toContain("Explicit");
  expect(result.tracks.find((track) => track.id === "1758502947")?.title).toContain("Explicit");
  expect(JSON.stringify(result)).not.toContain("temporary");
  expect(result.tracks.every((track) => !("duration" in track))).toBe(true);
  expect(read).toHaveBeenCalledTimes(47);
});

it("paginates artists, albums and tracks without duplicate artists or missing recordings", async () => {
  const client = new DeezerSubsonicClient(auth, readAlbumFixture);
  const page = await client.search3({
    ...pagination,
    artistOffset: 13,
    artistCount: 2,
    albumOffset: 46,
    albumCount: 2,
    songOffset: 570,
    songCount: 2,
  });
  expect(page.artists.map((artist) => artist.id)).toEqual(["689"]);
  expect(page.albums.map((album) => album.id)).toEqual(["108996972"]);
  expect(page.tracks).toHaveLength(1);
  const tracks = [];
  for (let songOffset = 0; songOffset < 600; songOffset += 50) {
    tracks.push(
      ...(
        await client.search3({
          ...pagination,
          artistCount: 0,
          albumCount: 0,
          songCount: 50,
          songOffset,
        })
      ).tracks,
    );
  }
  expect(tracks.map((track) => track.id)).toEqual(
    albumFixtures.flatMap((album) => album.tracks.data.map((track) => String(track.id))),
  );
});

it("uses original release years rather than Deezer edition dates", async () => {
  const read = vi.fn(async (path: string) => ({
    ...(await readAlbumFixture(path)),
    release_date: "2026-01-01",
  }));
  const result = await new DeezerSubsonicClient(auth, read).search3(pagination);
  const years = new Map(result.albums.map((album) => [album.id, album.year]));
  expect(years.get("302117")).toBe(2000);
  expect(years.get("59667692")).toBe(2009);
  expect(years.get("98920")).toBe(2002);
  expect(years.get("320369597")).toBe(2009);
  expect(years.get("14880317")).toBe(1995);
  expect(years.get("105614472")).toBe(1993);
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
  expect((await new DeezerSubsonicClient(auth, read).search3(pagination)).tracks).toHaveLength(571);
});

it.each(albumFixtures)("resolves a preview for $artist.name — $title", async (fixture) => {
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
  expect(await client.getStreamUrl("476972632")).toContain("fixture.mp3");
  read.mockResolvedValue({ ...archiveAlbumFixture.tracks.data[1], album: { id: 302117 } });
  await expect(client.getStreamUrl("476972632")).rejects.toThrow();
});

it("rejects missing recordings and mismatched artists", async () => {
  const read = vi.fn(async (path: string) => {
    const input = await readAlbumFixture(path);
    return path === "album/59667692" ? { ...input, artist: album.artist } : input;
  });
  await expect(new DeezerSubsonicClient(auth, read).ping()).rejects.toThrow("Unexpected");
  read.mockImplementation(async (path) => ({
    ...(await readAlbumFixture(path)),
    tracks: { data: [] },
  }));
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
