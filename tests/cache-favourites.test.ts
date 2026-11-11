import { afterEach, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.svelte";
import { installDisk } from "./cache-test-helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const state = {
  fetchedAt: 123,
  artists: [{ id: "same", title: "Missing artist" }],
  albums: [],
  tracks: [{ id: "same", title: "Missing song", artist: "Credit" }],
};
it("restores favourites independently and isolates accounts", async () => {
  installDisk();
  const first = new Cache("one");
  await first.load();
  first.setFavourites(state);
  await first.flush();
  const restored = new Cache("one");
  await restored.load();
  expect(restored.favourites).toEqual(state);
  expect(restored.tracks.size).toBe(0);
  const other = new Cache("two");
  await other.load();
  expect(other.favourites.fetchedAt).toBeNull();
  expect(other.favourites.artists).toEqual([]);
});
it("does not undo server-confirmed memory on checkpoint failure", async () => {
  const disk = installDisk();
  const cache = new Cache("one");
  await cache.load();
  cache.setFavourites(state);
  disk.state.failClose = true;
  await expect(cache.flush()).rejects.toThrow();
  expect(cache.favourites).toEqual(state);
  expect(cache.favouritesError).toBeDefined();
  disk.state.failClose = false;
  await cache.flush();
  expect(cache.favouritesError).toBeUndefined();
});
it.each(["unreadable", ""])(
  "preserves unreadable favourites (%j) even after a confirmed refresh",
  async (unreadable) => {
    const disk = installDisk();
    const first = new Cache("one");
    await first.load();
    first.setFavourites(state);
    await first.flush();
    const path = [...disk.files.keys()].find((path) => path.endsWith("/favourites.json"))!;
    disk.files.set(path, unreadable);
    const restored = new Cache("one");
    await expect(restored.load()).rejects.toThrow();
    restored.setFavourites(state);
    expect(restored.favourites).toEqual(state);
    await expect(restored.flush()).rejects.toThrow();
    expect(disk.files.get(path)).toBe(unreadable);
  },
);
