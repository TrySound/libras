import { describe, expect, it } from "vitest";
import { parseSearch, searchHref, searchTypes, splitRoute } from "../src/search-url";

describe("shareable search URLs", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask))("round trips combination %s", (mask) => {
    const types = searchTypes.filter((_, i) => mask & (1 << i));
    for (const query of ["", "  ", "Beyoncé 東京 + & % / ? #"]) {
      const url = new URL(searchHref(query, types), "https://example.test/demo/");
      const { path, parameters } = splitRoute(url.search);
      expect(path).toBe("/search");
      expect(parseSearch(parameters)).toEqual({ query, types });
      expect(url.pathname).toBe("/demo/");
      expect(url.hash).toBe("");
    }
  });
  it("ignores unknown types, deduplicates and canonicalizes, and uses the first q", () => {
    const criteria = parseSearch(
      new URLSearchParams("type=track&type=no&type=artist&type=track&q=first&q=second"),
    );
    expect(criteria).toEqual({ query: "first", types: ["artist", "track"] });
    expect(searchHref(criteria.query, criteria.types)).toBe(
      "?/search&type=artist&type=track&q=first",
    );
    expect(parseSearch(new URLSearchParams("type=unknown"))).toEqual({ query: "", types: [] });
    expect(searchHref()).toBe("?/search");
  });
  it("splits literal delimiters before decoding route IDs and leaves hash separate", () => {
    const url = new URL(
      "https://example.test/?/library/artist/a%26b%2Fc%3Fd%23e%25&ignored=x#anchor",
    );
    expect(splitRoute(url.search).path).toBe("/library/artist/a%26b%2Fc%3Fd%23e%25");
    expect(url.hash).toBe("#anchor");
  });
});
