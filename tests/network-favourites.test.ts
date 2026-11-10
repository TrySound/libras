import { afterEach, expect, it, vi } from "vitest";
import { Network } from "../src/network.svelte";
import { Cache } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";
import { SubsonicClient } from "../src/subsonic-client";
const auth = {
  host: "https://music.example",
  username: "user",
  credentials: { method: "token" as const, username: "user", token: "token", salt: "salt" },
};
const response = (fields: object) =>
  new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...fields } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["artists", "albums", "tracks"] as const)(
  "maps %s to its portable star parameter",
  async (kind) => {
    const fetcher = vi.fn(async () => response({}));
    const client = new SubsonicClient(auth, { fetch: fetcher });
    await client.star({ kind, id: "same" });
    await client.unstar({ kind, id: "same" });
    for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      const body = new URLSearchParams(String(init.body));
      expect(body.get(kind === "artists" ? "artistId" : kind === "albums" ? "albumId" : "id")).toBe(
        "same",
      );
      expect(["artistId", "albumId", "id"].filter((key) => body.has(key))).toHaveLength(1);
    }
  },
);
it.each([{}, { starred2: null }, { starred2: { song: {} } }])(
  "rejects missing or malformed starred2 %j",
  async (fields) => {
    const client = new SubsonicClient(auth, { fetch: async () => response(fields) });
    await expect(client.getStarred2()).rejects.toThrow();
  },
);
it("accepts optional arrays but normalizes descriptions without a complete library", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        starred2: {
          album: [{ id: "a", name: "Missing album", displayArtist: "Unknown credit" }],
          song: [{ id: "s", title: "Single" }],
        },
      }),
    ),
  );
  const controller = new AbortController();
  const network = new Network();
  const access = network.open(auth, controller.signal);
  // Downloaded filtering detaches normal access, not this authenticated lifetime.
  network.setMode("offline");
  const result = await access.favourites.read();
  expect(result.artists).toEqual([]);
  expect(result.albums[0]).toMatchObject({
    id: "a",
    title: "Missing album",
    artist: "Unknown credit",
  });
  expect(result.tracks[0].title).toBe("Single");
  await access.favourites.mutate({ kind: "tracks", id: "s" }, true);
  controller.abort();
  await expect(access.favourites.read()).rejects.toMatchObject({ name: "AbortError" });
});

it("retains standard singular credits for missing records, preferring extension credits when supplied", async () => {
  installDisk();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        starred2: {
          album: [
            { id: "baseline-album", name: "Missing baseline album", artist: "Baseline artist" },
            {
              id: "rich-album",
              name: "Rich album",
              artist: "Legacy credit",
              artists: [{ id: "artist", name: "Structured artist" }],
            },
          ],
          song: [
            { id: "baseline-song", title: "Missing baseline song", artist: "Baseline singer" },
            {
              id: "rich-song",
              title: "Rich song",
              artist: "Legacy credit",
              artists: [{ id: "artist", name: "Structured artist" }],
              displayArtist: "Rich display credit",
            },
            {
              id: "empty-extension",
              title: "Empty extension",
              artists: [],
              artist: "Standard fallback",
            },
          ],
        },
      }),
    ),
  );
  const controller = new AbortController();
  const access = new Network().open(auth, controller.signal);
  const state = await access.favourites.read();
  const cache = new Cache("baseline-account");
  await cache.load();
  cache.setFavourites(state);
  await cache.flush();
  const restored = new Cache("baseline-account");
  await restored.load();
  expect(restored.favourites.albums.map((item) => item.artist)).toEqual([
    "Baseline artist",
    "Structured artist",
  ]);
  expect(restored.favourites.tracks.map((item) => item.artist)).toEqual([
    "Baseline singer",
    "Rich display credit",
    "Standard fallback",
  ]);
  expect(restored.albums.size).toBe(0);
  expect(restored.tracks.size).toBe(0);
  controller.abort();
});
