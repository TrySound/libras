import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterEngine } from "../src/router-engine";

class TestURLPattern {
  #expression: RegExp;
  #names: string[] = [];

  constructor(init: URLPatternInit) {
    const source = String(init.hash).replace(/:([A-Za-z]+)/g, (_, name: string) => {
      this.#names.push(name);
      return "([^/]+)";
    });
    this.#expression = new RegExp(`^${source}$`);
  }

  exec(input: string | URL) {
    const match = this.#expression.exec(new URL(input).hash.slice(1));
    if (!match) return null;
    return {
      hash: {
        groups: Object.fromEntries(this.#names.map((name, index) => [name, match[index + 1]])),
      },
    } as unknown as URLPatternResult;
  }

  test(input: string | URL) {
    return this.exec(input) !== null;
  }
}

beforeEach(() => {
  vi.stubGlobal("URLPattern", TestURLPattern);
});

afterEach(() => vi.unstubAllGlobals());

const library = { pattern: "/library", name: "library" };
const artist = { pattern: "/library/artist/:artistId", name: "artist" };
const album = {
  pattern: "/library/artist/:artistId/album/:albumId",
  name: "album",
};
const player = { pattern: "/player", name: "player" };
const routes = [album, artist, library, player];

describe("router engine", () => {
  it.each(["reload", "push", "replace", "traverse"] as const)(
    "leaves reloads to the browser while routing hash navigation: %s",
    async (navigationType) => {
      const navigation = new EventTarget();
      const location = new URL("https://app.example/#/library");
      const scrollTo = vi.fn();
      vi.stubGlobal("window", { navigation, location, scrollTo });
      const router = new RouterEngine(routes, library);
      router.start();
      const intercept = vi.fn((options: { handler: () => void | Promise<void>; scroll?: string }) =>
        options.handler(),
      );
      const event = new Event("navigate");
      Object.assign(event, {
        navigationType,
        canIntercept: true,
        destination: {
          url: navigationType === "reload" ? location.href : "https://app.example/#/player",
        },
        intercept,
      });
      try {
        navigation.dispatchEvent(event);
        if (navigationType === "reload") {
          expect(intercept).not.toHaveBeenCalled();
          expect(scrollTo).not.toHaveBeenCalled();
          expect(router.match.route).toBe(library);
        } else {
          expect(intercept).toHaveBeenCalledOnce();
          expect(intercept.mock.calls[0][0].scroll).toBeUndefined();
          expect(intercept.mock.results[0].value).toBeInstanceOf(Promise);
          await intercept.mock.results[0].value;
          expect(scrollTo).not.toHaveBeenCalled();
          expect(router.match.route).toBe(player);
        }
      } finally {
        router.destroy();
      }
    },
  );

  it("resolves user-defined routes with decoded parameters", () => {
    const router = new RouterEngine(routes, library);

    expect(router.resolve("https://app.example/#/library")).toEqual({
      route: library,
      params: {},
    });
    expect(router.resolve("https://app.example/#/library/artist/artist%201")).toEqual({
      route: artist,
      params: { artistId: "artist 1" },
    });
    expect(router.resolve("https://app.example/#/library/artist/artist-1/album/album-1")).toEqual({
      route: album,
      params: { artistId: "artist-1", albumId: "album-1" },
    });
  });

  it("manages hash prefixes internally", () => {
    const router = new RouterEngine(routes, library);
    expect(router.href("/player")).toBe("#/player");
    expect(router.href("player")).toBe("#/player");
    expect(router.href("#/player")).toBe("#/player");
  });

  it("defaults unknown routes to the configured fallback", () => {
    const router = new RouterEngine(routes, library);
    expect(router.resolve("https://app.example/#/unknown")).toEqual({
      route: library,
      params: {},
    });
  });
});
