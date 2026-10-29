// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { DeezerSubsonicClient } from "./deezer-client";
import { albumFixtures, deezerAlbumFixture as album, archiveAlbumFixture } from "./deezer-fixtures";
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
  const read = vi.fn().mockRejectedValue(new Error("Unexpected live catalog request"));
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
  expect(read).not.toHaveBeenCalled();
});

it("paginates artists, albums and tracks without duplicate artists or missing recordings", async () => {
  const client = new DeezerSubsonicClient(auth);
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
  const result = await new DeezerSubsonicClient(auth).search3(pagination);
  const years = new Map(result.albums.map((album) => [album.id, album.year]));
  expect(years.get("302117")).toBe(2000);
  expect(years.get("59667692")).toBe(2009);
  expect(years.get("98920")).toBe(2002);
  expect(years.get("320369597")).toBe(2009);
  expect(years.get("14880317")).toBe(1995);
  expect(years.get("105614472")).toBe(1993);
});

it("syncs the committed snapshot even when live Deezer data is unavailable or mismatched", async () => {
  const read = vi.fn().mockRejectedValue(new Error("Deezer unavailable"));
  const client = new DeezerSubsonicClient(auth, read);
  await expect(client.ping()).resolves.toMatchObject({ openSubsonic: true });
  expect((await client.search3(pagination)).tracks).toHaveLength(571);
  read.mockResolvedValue({ ...album, id: 999, artist: { id: 999, name: "Unexpected artist" } });
  expect((await client.search3(pagination)).albums).toHaveLength(47);
  expect(read).not.toHaveBeenCalled();
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

it("rejects metadata access after disconnect or scan cancellation", async () => {
  const client = new DeezerSubsonicClient(auth);
  client.abort();
  await expect(client.ping()).rejects.toMatchObject({ name: "AbortError" });
  await expect(client.search3(pagination)).rejects.toMatchObject({ name: "AbortError" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    new DeezerSubsonicClient(auth).search3(pagination, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("resolves Bullets only for the selected Archive album and artist", async () => {
  const read = vi
    .fn()
    .mockResolvedValue({ ...archiveAlbumFixture.tracks.data[1], album: { id: 59667692 } });
  const client = new DeezerSubsonicClient(auth, read);
  expect(await client.getStreamUrl("476972632")).toContain("fixture.mp3");
  read.mockResolvedValue({ ...archiveAlbumFixture.tracks.data[1], album: { id: 302117 } });
  const failure = client.getStreamUrl("476972632");
  await expect(failure).rejects.toThrow("Bullets");
  await expect(failure).rejects.toThrow("expected track 476972632, album 59667692, artist 1334");
  await expect(failure).rejects.toThrow("received track 476972632, album 302117, artist 1334");
  await expect(failure).rejects.not.toThrow("temporary");
});

it.each([
  { id: 999, artist: { id: 702 } },
  { id: 3135439, artist: { id: 999 } },
])("rejects a different recording or artist at playback time: %j", async (identity) => {
  const read = vi
    .fn()
    .mockResolvedValue({ ...album.tracks.data[0], ...identity, album: { id: 302117 } });
  await expect(new DeezerSubsonicClient(auth, read).getStreamUrl("3135439")).rejects.toThrow(
    "different recording",
  );
});

it("reports malformed or removed playback data as unavailable", async () => {
  const read = vi.fn().mockResolvedValue({ error: { message: "removed" } });
  await expect(new DeezerSubsonicClient(auth, read).getStreamUrl("3135439")).rejects.toThrow(
    "preview unavailable for A Perfect Circle — The Hollow",
  );
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
