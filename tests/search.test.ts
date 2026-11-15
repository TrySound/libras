import { describe, expect, it } from "vitest";
import {
  createSearchIndex,
  searchLibrary,
  parseSearch,
  searchHref,
  searchTypes,
} from "../src/_search.svelte";
import type { Album, Artist, Track } from "../src/schema";

describe("shareable search URLs", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask))("round trips combination %s", (mask) => {
    const types = searchTypes.filter((_, i) => mask & (1 << i));
    for (const query of ["", "  ", "Beyoncé 東京 + & % / ? #"]) {
      const url = new URL(searchHref(query, types), "https://example.test/demo/");
      expect(url.search.startsWith("?/library")).toBe(true);
      expect(url.searchParams.get("/library")).toBe("");
      expect(parseSearch(url.searchParams)).toEqual({ query, types });
      expect(url.pathname).toBe("/demo/");
      expect(url.hash).toBe("");
    }
  });

  it("reads only q/types from complete parameters without mutating them", () => {
    const parameters = new URLSearchParams(
      "/search&type=track&unknown=keep&type=no&type=artist&type=track&q=first&q=second",
    );
    const entries = [...parameters];
    const criteria = parseSearch(parameters);
    expect(criteria).toEqual({ query: "first", types: ["artist", "track"] });
    expect([...parameters]).toEqual(entries);
    expect(searchHref(criteria.query, criteria.types)).toBe(
      "?/library&type=artist&type=track&q=first",
    );
    expect(searchHref("lemonade", ["album", "album"])).toBe("?/library&type=album&q=lemonade");
    expect(parseSearch(new URLSearchParams("/search&type=unknown"))).toEqual({
      query: "",
      types: [],
    });
    expect(parseSearch(new URLSearchParams("/search&q=&q=second"))).toEqual({
      query: "",
      types: [],
    });
    expect(searchHref()).toBe("?/library");
  });

  it("does not read search criteria from an anchor", () => {
    const url = new URL("https://example.test/?/search#q=ignored&type=track");
    expect(parseSearch(url.searchParams)).toEqual({ query: "", types: [] });
  });
});

function fixture(count = 12) {
  const artists = new Map<string, Artist>([["a", { id: "a", name: "Beyoncé" }]]);
  const albums = new Map<string, Album>([
    ["b", { id: "b", title: "Lemonade", artistIds: ["a"], genres: [] }],
  ]);
  const tracks = new Map<string, Track>(
    Array.from({ length: count }, (_, i) => {
      const id = String(i).padStart(2, "0");
      return [id, { id, title: "Formation", albumId: "b", artistIds: ["a"], genres: [] }];
    }),
  );
  return { artists, albums, tracks };
}

describe("local library search", () => {
  const { artists, albums, tracks } = fixture();
  const index = createSearchIndex(artists, albums, tracks);
  const search = (query: string) => searchLibrary(index, query).groups;
  it("handles case, accents, whitespace, subsequences, and multiple fields", () => {
    expect(search("BEYONCE")[0].records[0]?.title).toBe("Beyoncé");
    expect(search("  formation   lemonade  ")[2].total).toBe(12);
    expect(search("frmtn")[2].total).toBe(12);
    expect(search("lemonade beyonce")[1].total).toBe(1);
  });
  it("preserves and searches the album display credit", () => {
    const { artists, albums, tracks } = fixture();
    albums.set("b", { ...albums.get("b")!, displayArtist: "Beyoncé & Guests" });
    const result = searchLibrary(createSearchIndex(artists, albums, tracks), "guests").groups[1];
    expect(result.records[0]).toMatchObject({
      id: "b",
      artist: "Beyoncé & Guests",
      href: "?/library/album/b",
    });
  });

  it("explicitly handles empty and unmatched queries", () => {
    for (const query of ["", " \n\t ", "zzzzzzzz"]) {
      expect(search(query).every((group) => group.total === 0)).toBe(true);
    }
  });
  it("enumerates complete single-type browse results in cache order, including offline eligibility", () => {
    const { artists, albums, tracks } = fixture(1500);
    const reverse = new Map([...tracks].reverse());
    const index = createSearchIndex(artists, albums, reverse);
    const result = searchLibrary(index, "  ", true).groups[2];
    expect(result.total).toBe(1500);
    expect(result.records.map((record) => record.id)).toEqual([...reverse.keys()]);
    expect(searchLibrary(index, "formation", true).groups[2].total).toBe(1500);
    const offline = createSearchIndex(artists, albums, reverse, (id) => id === "1499");
    expect(searchLibrary(offline, "", true).groups.map((group) => group.total)).toEqual([1, 1, 1]);
  });
  it("ranks all matches independently of pagination and keeps ties deterministic", () => {
    expect(search("formation")[2].records.map((r) => r.id)).toEqual([...tracks.keys()]);
    const reverse = createSearchIndex(artists, albums, new Map([...tracks].reverse()));
    expect(searchLibrary(reverse, "formation").groups).toEqual(search("formation"));
  });
  it("returns the normalized query for presentation", () => {
    expect(searchLibrary(index, "  formation   lemonade  ").query).toBe("formation lemonade");
  });
  it("prefers title matches to secondary matches", () => {
    const extra = new Map(tracks);
    extra.set("other", {
      id: "other",
      title: "Beyoncé",
      artistIds: ["a"],
      albumId: "b",
      genres: [],
    });
    expect(
      searchLibrary(createSearchIndex(artists, albums, extra), "beyonce").groups[2].records[0].id,
    ).toBe("other");
  });
  it("filters availability before limiting, including parent albums and artists", () => {
    const offline = createSearchIndex(artists, albums, tracks, (id) => id === "11");
    expect(searchLibrary(offline, "formation").groups[2].records.map((r) => r.id)).toEqual(["11"]);
    expect(searchLibrary(offline, "beyonce").groups.map((g) => g.total)).toEqual([1, 1, 1]);
    expect(createSearchIndex(artists, albums, tracks, () => false).size).toBe(0);
  });
});
