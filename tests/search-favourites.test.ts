import { describe, expect, it } from "vitest";
import { createSearchIndex, searchLibrary, parseSearch, searchHref } from "../src/_search.svelte";
import type { Album, Artist, Track, FavouriteState } from "../src/schema";

const artists = new Map<string, Artist>([
  ["same", { id: "same", name: "Zulu" }],
  ["guest", { id: "guest", name: "Guest" }],
]);
const albums = new Map<string, Album>([
  ["same", { id: "same", title: "Alpha", artistIds: ["same"], genres: [] }],
]);
const tracks = new Map<string, Track>([
  ["same", { id: "same", title: "Bravo", albumId: "same", artistIds: ["guest"], genres: [] }],
  ["a", { id: "a", title: "Bravo", albumId: "same", artistIds: ["same"], genres: [] }],
]);
const favourites: FavouriteState = {
  fetchedAt: 1,
  artists: [{ id: "same", title: "Obsolete metadata" }],
  albums: [],
  tracks: [{ id: "missing", title: "Saved song", artist: "Saved credit" }],
};
const index = createSearchIndex(artists, albums, tracks, undefined, favourites);
const ordinary = createSearchIndex(artists, albums, tracks);
const search = (query = "", favourite = true) =>
  searchLibrary(favourite ? index : ordinary, query, true).groups;

describe("URL favourites modifier", () => {
  it("accepts only 1, omits false and canonicalizes types without interpreting text", () => {
    for (const value of ["", "true", "0", "false", "2"])
      expect(parseSearch(new URLSearchParams({ favourite: value })).favourite).toBe(false);
    const query = ":artist :favourite café + & #";
    const href = searchHref(query, ["track", "artist", "track"], true);
    expect(href).toContain("type=artist&type=track&favourite=1&q=");
    expect(parseSearch(new URL(href, "https://example.test").searchParams)).toEqual({
      query,
      types: ["artist", "track"],
      favourite: true,
    });
    expect(searchHref("", [], false)).toBe("?/search");
    expect(search(":favourite").every((group) => group.total === 0)).toBe(true);
  });
  it("browses independent membership without text and intersects text", () => {
    expect(search().map((group) => group.total)).toEqual([1, 0, 1]);
    expect(search("Bravo")[2].total).toBe(0);
    expect(search("", false)[0].records.map((record) => record.id)).toEqual(["same", "guest"]);
    expect(searchLibrary(index, "").groups.every((group) => group.total === 0)).toBe(true);
  });
  it("prefers current metadata and supplements only favourites, even with an empty library", () => {
    expect(search()[0].records[0].title).toBe("Zulu");
    expect(search()[2].records[0]).toMatchObject({
      id: "missing",
      title: "Saved song",
      artist: "Saved credit",
      unavailable: true,
    });
    expect(search()[2].records[0].href).toBeUndefined();
    expect(search("Saved", false)[2].total).toBe(0);
    const empty = createSearchIndex(new Map(), new Map(), new Map(), undefined, favourites);
    expect(searchLibrary(empty, "", true).groups.map((group) => group.total)).toEqual([1, 0, 1]);
  });
  it("ANDs downloaded eligibility and preserves credited contributors", () => {
    const downloaded = createSearchIndex(artists, albums, tracks, (id) => id === "a", {
      ...favourites,
      artists: [{ id: "guest", title: "Guest" }],
    });
    expect(
      searchLibrary(
        createSearchIndex(artists, albums, tracks, (id) => id === "a"),
        "",
        true,
      ).groups[0].records.map((record) => record.id),
    ).toEqual(["same", "guest"]);
    expect(
      searchLibrary(downloaded, "", true).groups.map((group) =>
        group.records.map((record) => record.id),
      ),
    ).toEqual([["guest"], [], []]);
    expect(searchLibrary(downloaded, "Bravo").groups[2].total).toBe(0);
  });
  it("reacts to confirmed removal without falling back to ordinary results", () => {
    const next = createSearchIndex(artists, albums, tracks, undefined, {
      fetchedAt: 2,
      artists: [],
      albums: [],
      tracks: [],
    });
    expect(searchLibrary(next, "", true).groups.every((group) => group.total === 0)).toBe(true);
    expect(favourites.artists).toHaveLength(1);
    expect(search()[0].total).toBe(1);
  });
});
