// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { DeezerSubsonicClient } from "./deezer-client";
import { deezerAlbumFixture as album } from "./deezer-fixtures";
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
  songCount: 10,
  songOffset: 0,
};

it("loads three real recording IDs into the library without persisting preview URLs or original durations", async () => {
  const read = vi.fn().mockResolvedValue(album);
  const client = new DeezerSubsonicClient(auth, read);
  await client.ping();
  const result = await client.search3(pagination);
  expect(result.artists[0].name).toBe("A Perfect Circle");
  expect(result.albums[0].name).toBe("Mer De Noms");
  expect(result.tracks.map((track) => track.id)).toEqual(["3135439", "3135442", "3135444"]);
  expect(result.tracks[1].title).toContain("Explicit");
  expect(JSON.stringify(result)).not.toContain("temporary");
  expect(result.tracks[0]).not.toHaveProperty("duration");
  expect((await client.search3({ ...pagination, songOffset: 1, songCount: 1 })).tracks[0].id).toBe(
    "3135442",
  );
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not require playback fields to browse the album", async () => {
  const read = vi.fn().mockResolvedValue({
    ...album,
    tracks: {
      data: album.tracks.data.map(({ id, title, explicit_lyrics, artist }) => ({
        id,
        title,
        explicit_lyrics,
        artist,
      })),
    },
  });
  const client = new DeezerSubsonicClient(auth, read);
  expect((await client.search3(pagination)).tracks).toHaveLength(3);
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
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(album);
  const client = new DeezerSubsonicClient(auth, read);
  await expect(client.ping()).rejects.toThrow("offline");
  await expect(client.ping()).resolves.toMatchObject({ openSubsonic: true });
  const stale = new DeezerSubsonicClient(auth, async () => {
    stale.abort();
    return album;
  });
  await expect(stale.ping()).rejects.toMatchObject({ name: "AbortError" });
});

it("blocks download reads before requesting a preview and supports async playback through Network", async () => {
  const read = vi.fn().mockResolvedValue({ ...album.tracks.data[0], album: { id: 302117 } });
  const network = new Network((identity) => new DeezerSubsonicClient(identity, read));
  const connection = network.accept(network.prepare(auth));
  expect(connection.audio.downloadsAllowed).toBe(false);
  await expect(
    connection.audio.read("3135439", { format: "raw", signal: new AbortController().signal }),
  ).rejects.toThrow("disabled");
  expect(read).not.toHaveBeenCalled();
  expect(await connection.audio.url("3135439", { format: "raw" })).toContain(
    "https://cdnt-preview.dzcdn.net/",
  );
  network.setMode("offline");
});
