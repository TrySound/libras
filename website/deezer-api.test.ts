// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { afterEach, expect, it, vi } from "vitest";
import { readDeezer } from "./deezer-api";

afterEach(() => {
  vi.useRealTimers();
  document.head.replaceChildren();
});

function request() {
  const script = document.querySelector<HTMLScriptElement>(
    'script[src^="https://api.deezer.com/"]',
  )!;
  const url = new URL(script.src);
  const name = url.searchParams.get("callback")!;
  const callback = (window as unknown as Record<string, (data: unknown) => void>)[name];
  return { script, url, name, callback };
}

it("uses only the fixed API allowlist, with unique callbacks and no referrer", async () => {
  const signal = new AbortController().signal;
  const pending = readDeezer("album/302117", signal);
  const { script, url, name, callback } = request();
  expect(url.origin).toBe("https://api.deezer.com");
  expect(url.searchParams.get("output")).toBe("jsonp");
  expect(script.referrerPolicy).toBe("no-referrer");
  callback({ example: true });
  expect(await pending).toEqual({ example: true });
  expect(script.isConnected).toBe(false);
  expect(name in window).toBe(false);
  await expect(readDeezer("https://evil.test/track/3135439", signal)).rejects.toThrow("allowlist");
});

it.each([
  "album/59667692",
  "track/476972632",
  "track/476972742",
  "album/320369597",
  "track/1758502927",
  "album/14879699",
  "track/138539971",
  "album/355921",
  "track/3787855",
])("allows selected catalog request %s", async (path) => {
  const pending = readDeezer(path, new AbortController().signal);
  request().callback({ example: true });
  await expect(pending).resolves.toEqual({ example: true });
});

it.each(["album/895746612", "album/1", "track/476972633", "album/59667692/extra"])(
  "rejects requests outside the catalog: %s",
  async (path) => {
    await expect(readDeezer(path, new AbortController().signal)).rejects.toThrow("allowlist");
  },
);

it("cancels immediately and ignores callbacks already in flight", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = readDeezer("track/3135439", controller.signal);
  const { name, script } = request();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(script.isConnected).toBe(false);
  const callbacks = window as unknown as Record<string, (data: unknown) => void>;
  expect(() => callbacks[name]({ stale: true })).not.toThrow();
  vi.runAllTimers();
  expect(name in window).toBe(false);
});

it("fails on timeout without retrying", async () => {
  vi.useFakeTimers();
  const pending = readDeezer("album/302117", new AbortController().signal);
  const failure = expect(pending).rejects.toThrow("timed out");
  vi.advanceTimersByTime(15_000);
  await failure;
  expect(document.querySelector("script")).toBeNull();
  vi.runAllTimers();
});
