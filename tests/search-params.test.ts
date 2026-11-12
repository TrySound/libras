// @vitest-environment happy-dom
import { flushSync, tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { getSearchParameters } from "../src/router.svelte";
import { observeSearchParameters } from "./search-params-test-reader.svelte";
import { installNavigation, navigationEvent } from "./router-test-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reads the complete initial parameters without mounting Router", () => {
  installNavigation("/search=&unknown=first&type=album&type=track&q=one&q=two&unknown=last");
  expect([...getSearchParameters()]).toEqual([
    ["/search", ""],
    ["unknown", "first"],
    ["type", "album"],
    ["type", "track"],
    ["q", "one"],
    ["q", "two"],
    ["unknown", "last"],
  ]);
});

it("reads the committed entry even while location still names the previous entry", () => {
  const navigation = installNavigation("/search&q=old");
  navigation.commit("?/search&q=committed", false);
  expect(new URL(window.location.href).searchParams.get("q")).toBe("old");
  expect(getSearchParameters().get("q")).toBe("committed");
});

it("falls back to location when no current entry URL is available", () => {
  installNavigation("/search&q=fallback");
  vi.stubGlobal("navigation", { currentEntry: undefined });
  expect(getSearchParameters().get("q")).toBe("fallback");
});

it("reacts only to commits, preserves hash identity and reads fresh state after disposal", async () => {
  const navigation = installNavigation("/search&q=initial");
  const read = vi.fn();
  let stop = observeSearchParameters(read);
  try {
    flushSync();
    expect(read.mock.lastCall![0].get("q")).toBe("initial");
    navigation.navigate("?/search&q=attempt", { history: "push" });
    const controller = new AbortController();
    controller.abort();
    navigation.dispatchEvent(
      Object.assign(navigationEvent(), {
        signal: controller.signal,
        destination: { url: new URL("?/search&q=canceled", window.location.href).href },
      }),
    );
    flushSync();
    expect(read.mock.lastCall![0].get("q")).toBe("initial");
    navigation.commit("?/search&q=committed", false);
    flushSync();
    expect(read.mock.lastCall![0].get("q")).toBe("committed");
    const parameters = getSearchParameters();
    navigation.commit("?/search&q=committed#anchor", false);
    flushSync();
    expect(getSearchParameters()).toBe(parameters);
    navigation.commit("?unrouted=one&unrouted=two", false);
    flushSync();
    expect([...read.mock.lastCall![0]]).toEqual([
      ["unrouted", "one"],
      ["unrouted", "two"],
    ]);
    stop();
    await tick();
    read.mockClear();
    navigation.commit("?/search&q=while-unsubscribed");
    flushSync();
    expect(read).not.toHaveBeenCalled();
    stop = observeSearchParameters(read);
    flushSync();
    expect(read.mock.lastCall![0].get("q")).toBe("while-unsubscribed");
  } finally {
    stop();
    await tick();
  }
});
