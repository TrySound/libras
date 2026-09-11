import { vi } from "vitest";
import type { Cache } from "./cache.svelte";
import type { Artist, Album, Track } from "./schema";

/** Real reactive selection for engine tests; no copied cache collections. */
export class TestSelection {
  cache = $state.raw<Cache>();
}

/** Only isolated playback policy tests bypass library persistence. */
export function playbackLibrary(cache: Cache) {
  const library = $state({
    artists: new Map<string, Artist>(),
    albums: new Map<string, Album>(),
    tracks: new Map<string, Track>(),
  });
  vi.spyOn(cache, "artists", "get").mockImplementation(() => library.artists);
  vi.spyOn(cache, "albums", "get").mockImplementation(() => library.albums);
  vi.spyOn(cache, "tracks", "get").mockImplementation(() => library.tracks);
  return library;
}
