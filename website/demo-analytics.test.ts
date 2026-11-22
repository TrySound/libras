// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { demoPageUrl, trackDemoNavigation } from "./demo-analytics";
import { installNavigation } from "../tests/router-test-helpers";

afterEach(() => {
  delete (window as Window & { plausible?: unknown }).plausible;
  vi.unstubAllGlobals();
});

it.each([
  ["", "library"],
  ["?/library", "library"],
  ["?/library/artist/123", "artist"],
  ["?/library/album/private%2Fid", "album"],
  ["?/search&q=private+search&artists=true#private", "search"],
  ["?/settings#server", "settings"],
  ["?/downloads", "downloads"],
  ["?/search=&q=private", "search"],
  ["?unknown=private", "library"],
  ["?/library/artist/123=private", "library"],
])("normalizes %s without IDs, searches, or fragments", (query, screen) => {
  expect(demoPageUrl(`https://libras-music.app/demo/${query}`)).toBe(
    `https://libras-music.app/demo/${screen}`,
  );
  expect(demoPageUrl(`https://example.com/base/demo/index.html${query}`)).toBe(
    `https://example.com/base/demo/${screen}`,
  );
});

it("counts distinct routes without transmitting IDs or counting search and anchor updates", () => {
  const navigation = installNavigation("/library");
  const plausible = Object.assign(vi.fn(), { init: vi.fn<(options: any) => void>() });
  Object.assign(window, { plausible });
  const stop = trackDemoNavigation();
  expect(plausible.init).toHaveBeenCalledOnce();
  const options = plausible.init.mock.calls[0]![0];
  expect(options).toEqual({
    autoCapturePageviews: false,
    transformRequest: expect.any(Function),
  });
  expect(plausible).toHaveBeenCalledTimes(1);
  void navigation.navigate("?/search", { history: "push" });
  expect(plausible).toHaveBeenCalledTimes(1);
  navigation.commit("https://libras-music.app/demo/?/library/artist/123", false);
  navigation.commit("https://libras-music.app/demo/?/library/artist/456", false);
  navigation.commit("https://libras-music.app/demo/?/library/artist/456#albums", false);
  navigation.commit("https://libras-music.app/demo/?/search&q=private", false);
  navigation.commit("https://libras-music.app/demo/?/search&q=another-private", false);
  navigation.commit("https://libras-music.app/demo/?/library", false);
  expect(plausible.mock.calls.slice(1)).toEqual([
    ["pageview", { url: "https://libras-music.app/demo/artist" }],
    ["pageview", { url: "https://libras-music.app/demo/artist" }],
    ["pageview", { url: "https://libras-music.app/demo/search" }],
    ["pageview", { url: "https://libras-music.app/demo/library" }],
  ]);
  const payload = options.transformRequest({
    n: "pageview",
    u: "https://libras-music.app/demo/search",
    r: "https://libras-music.app/demo/?/library/artist/123#albums",
  });
  expect(payload).toEqual({
    n: "pageview",
    u: "https://libras-music.app/demo/search",
    r: "https://libras-music.app/demo/",
  });
  expect(
    options.transformRequest({
      n: "Outbound Link: Click",
      u: "https://libras-music.app/demo/?/library/artist/123",
      p: { url: "https://www.deezer.com/artist/123" },
    }),
  ).toEqual({
    n: "Outbound Link: Click",
    u: "https://libras-music.app/demo/artist",
    p: { url: "https://www.deezer.com/artist/123" },
  });
  stop();
  navigation.commit("https://libras-music.app/demo/?/settings", false);
  expect(plausible).toHaveBeenCalledTimes(5);
});

it("uses the live tracker when initialization replaces the queued bootstrap", () => {
  const navigation = installNavigation("/library");
  const live = vi.fn();
  const bootstrap = Object.assign(vi.fn(), {
    init: vi.fn(() => Object.assign(window, { plausible: live })),
  });
  Object.assign(window, { plausible: bootstrap });
  const stop = trackDemoNavigation();
  expect(bootstrap).not.toHaveBeenCalled();
  expect(live).toHaveBeenCalledOnce();
  navigation.commit("https://libras-music.app/demo/?/search", false);
  expect(live).toHaveBeenCalledTimes(2);
  stop();
});

it("does not affect the demo when the tracking bootstrap is unavailable", () => {
  installNavigation();
  expect(() => trackDemoNavigation()()).not.toThrow();
});
