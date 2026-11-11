import { describe, expect, it } from "vitest";
import {
  createSearchIndex,
  searchLibrary,
  createSearchState,
  parseSearch,
} from "../src/_search.svelte";
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
const search = (query: string) => searchLibrary(index, query).groups;

describe("Search directives and retained favourites", () => {
  it("recognizes only standalone case-insensitive directives and keeps unknown text literal", () => {
    const parsed = parseSearch(":ARTIST :artist :album :FAVOURITE text :unknown word:track");
    expect([...parsed.kinds]).toEqual(["artist", "album"]);
    expect(parsed.favourite).toBe(true);
    expect(parsed.text).toBe("text :unknown word:track");
    expect(parseSearch("hello:artist").directed).toBe(false);
  });
  it("ORs selected kinds and ANDs independent per-kind favourite membership", () => {
    expect(search(":artist :album").map((group) => group.total)).toEqual([2, 1, 0]);
    expect(search(":artist :album :favourite").map((group) => group.total)).toEqual([1, 0, 0]);
    expect(search(":favourite").map((group) => group.total)).toEqual([1, 0, 1]);
    expect(search(":track :favourite Bravo")[2].total).toBe(0);
  });
  it("uses alphabetical displayed names with ID ties for directive-only browsing", () => {
    expect(search(":artist")[0].records.map((record) => record.title)).toEqual(["Guest", "Zulu"]);
    expect(search(":track")[2].records.map((record) => record.id)).toEqual(["a", "same"]);
    expect(search(" ").every((group) => group.total === 0)).toBe(true);
    expect(createSearchState("text").limits.Tracks).toBe(3);
    expect(createSearchState(":track text").limits.Tracks).toBe(10);
  });
  it("prefers library metadata, supplements only favourite searches, and retains unavailable identities", () => {
    expect(search(":artist :favourite")[0].records[0].title).toBe("Zulu");
    const missing = search(":track :favourite")[2].records[0];
    expect(missing).toMatchObject({
      id: "missing",
      title: "Saved song",
      artist: "Saved credit",
      unavailable: true,
    });
    expect(missing.href).toBeUndefined();
    expect(search("Saved")[2].total).toBe(0);
    const emptyLibrary = createSearchIndex(new Map(), new Map(), new Map(), undefined, favourites);
    expect(searchLibrary(emptyLibrary, ":favourite").groups.map((group) => group.total)).toEqual([
      1, 0, 1,
    ]);
  });
  it("applies downloaded eligibility before membership/matching and includes track-only contributors", () => {
    const downloaded = createSearchIndex(
      artists,
      albums,
      tracks,
      (id) => id === "same",
      favourites,
    );
    expect(
      searchLibrary(downloaded, ":artist").groups[0].records.map((record) => record.id),
    ).toEqual(["guest", "same"]);
    expect(searchLibrary(downloaded, ":favourite").groups.map((group) => group.total)).toEqual([
      1, 0, 0,
    ]);
    expect(searchLibrary(downloaded, "Bravo").groups[2].total).toBe(1);
  });
  it("keeps undownloaded guests eligible through their downloaded credited album", () => {
    // Album owner 'same' has the downloaded song; guest appears only on an
    // undownloaded song of that same album, not on the downloaded track itself.
    const downloaded = createSearchIndex(artists, albums, tracks, (id) => id === "a", {
      ...favourites,
      artists: [{ id: "guest", title: "Guest" }],
    });
    expect(
      searchLibrary(downloaded, ":artist").groups[0].records.map((record) => record.id),
    ).toEqual(["guest", "same"]);
    expect(
      searchLibrary(downloaded, ":artist :favourite").groups[0].records.map((record) => record.id),
    ).toEqual(["guest"]);
    expect(
      searchLibrary(downloaded, ":track").groups[2].records.map((record) => record.id),
    ).toEqual(["a"]);
    expect(
      searchLibrary(downloaded, ":album").groups[1].records.map((record) => record.id),
    ).toEqual(["same"]);
  });
  it("updates membership without mutating inputs or falling back to ordinary results", () => {
    const next = createSearchIndex(artists, albums, tracks, undefined, {
      fetchedAt: 2,
      artists: [],
      albums: [],
      tracks: [],
    });
    expect(searchLibrary(next, ":favourite").groups.every((group) => group.total === 0)).toBe(true);
    expect(favourites.artists).toHaveLength(1);
    expect(search(":favourite")[0].total).toBe(1);
  });
});
