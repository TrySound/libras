import { afterEach, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { Favourites } from "../src/favourites.svelte";
import { getAccountKey } from "../src/auth";
import type { FavouriteState, FavouriteTarget } from "../src/schema";
import { installDisk } from "./cache-test-helpers";
import legacy from "./fixtures/legacy-synthetic-library.json";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("guards restored pre-provenance targets until library refresh, but permits proven server removals and songs", async () => {
  const disk = installDisk();
  const account = { host: "https://music.example", username: "legacy" };
  const seed = new Cache(getAccountKey(account));
  await seed.load();
  await seed.replaceLibrary(legacy);
  await seed.flush();
  const path = [...disk.files.keys()].find((path) => path.endsWith("/library.json"))!;
  disk.files.set(path, JSON.stringify(legacy));
  const cache = new Cache(getAccountKey(account));
  await cache.load();
  const favourites = new Favourites({ cache });
  let remote: FavouriteState = { fetchedAt: 1, artists: [], albums: [], tracks: [] };
  const mutate = vi.fn(async (target: FavouriteTarget, selected: boolean) => {
    remote[target.kind] = selected
      ? [...remote[target.kind], { id: target.id, title: "Server title" }]
      : remote[target.kind].filter((item) => item.id !== target.id);
  });
  favourites.setConnection({
    account,
    signal: new AbortController().signal,
    read: async () => structuredClone(remote),
    mutate,
  });
  for (const target of [
    { kind: "artists", id: legacy.artists[0].id },
    { kind: "albums", id: legacy.albums[0].id },
    { kind: "artists", id: "ordinary-server" },
  ] as const) {
    expect(favourites.targetError(target)).toContain("Refresh the library");
    await expect(favourites.toggle(target)).rejects.toThrow("Refresh the library");
  }
  expect(mutate).not.toHaveBeenCalled();
  await favourites.toggle({ kind: "tracks", id: "server-song" });
  expect(mutate).toHaveBeenCalledOnce();
  remote.artists = [{ id: legacy.artists[0].id, title: "Genuine server artist" }];
  remote.albums = [{ id: legacy.albums[0].id, title: "Genuine server album" }];
  await favourites.refresh();
  await favourites.toggle({ kind: "artists", id: legacy.artists[0].id });
  await favourites.toggle({ kind: "albums", id: legacy.albums[0].id });
  expect(remote.artists).toEqual([]);
  expect(remote.albums).toEqual([]);
  expect(favourites.targetError({ kind: "artists", id: legacy.artists[0].id })).toContain(
    "Refresh the library",
  );
  // A subsequent normalized library refresh proves genuine records without prefix assumptions.
  await cache.replaceLibrary({
    ...legacy,
    savedAt: 2,
    lastModified: 2,
    artists: legacy.artists.map((artist) => ({
      ...artist,
      localOnly: artist.id !== "ordinary-server",
    })),
    albums: legacy.albums.map((album) => ({ ...album, localOnly: true })),
  });
  await favourites.toggle({ kind: "artists", id: "ordinary-server" });
  expect(favourites.targetError({ kind: "albums", id: legacy.albums[0].id })).toContain(
    "local collection",
  );
  await cache.flush();
  favourites.destroy();
});
