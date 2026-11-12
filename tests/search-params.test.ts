// @vitest-environment happy-dom
import { flushSync, tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { getSearchParameters } from "../src/router.svelte";
import { observeSearchParameters } from "./search-params-test-reader.svelte";
import { installNavigation, navigationEvent } from "./router-test-helpers";

const cleanups = new Set<() => void>();
afterEach(async () => {
  for (const stop of cleanups) stop();
  cleanups.clear();
  await tick();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function observe(read: (parameters: URLSearchParams) => void) {
  const dispose = observeSearchParameters(read);
  const stop = () => {
    dispose();
    cleanups.delete(stop);
  };
  cleanups.add(stop);
  flushSync();
  return stop;
}

it.each(["/player", "/player=", "/player=invalid"])(
  "reads full initial parameters without Router or a subscription: %s",
  (path) => {
    const navigation = installNavigation(
      `${path}&unknown=first&type=album&type=track&q=one&q=two&unknown=last`,
    );
    const add = vi.spyOn(navigation, "addEventListener");
    expect([...getSearchParameters()]).toEqual([...new URL(window.location.href).searchParams]);
    expect([...getSearchParameters()][0]).toEqual([
      "/player",
      path.includes("invalid") ? "invalid" : "",
    ]);
    expect(add).not.toHaveBeenCalled();
  },
);

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

it.each(["push", "replace", "traverse"])(
  "observes committed %s, not attempted or canceled destinations",
  (navigationType) => {
    const navigation = installNavigation("/search&q=initial");
    const read = vi.fn();
    observe(read);
    expect(read.mock.lastCall![0].get("q")).toBe("initial");
    navigation.navigate("?/search&q=attempt", { history: "push" });
    const controller = new AbortController();
    controller.abort();
    navigation.dispatchEvent(
      Object.assign(navigationEvent(), {
        navigationType,
        signal: controller.signal,
        destination: { url: new URL("?/search&q=canceled", window.location.href).href },
      }),
    );
    flushSync();
    expect(read).toHaveBeenCalledTimes(1);
    navigation.commit(
      "?/search=&unknown=first&type=track&type=album&q=committed&q=second&unknown=last",
    );
    flushSync();
    expect([...read.mock.lastCall![0]]).toEqual([
      ["/search", ""],
      ["unknown", "first"],
      ["type", "track"],
      ["type", "album"],
      ["q", "committed"],
      ["q", "second"],
      ["unknown", "last"],
    ]);
  },
);

it("reacts to unintercepted commits and ignores hash-only changes", () => {
  const navigation = installNavigation("/search&q=initial");
  const read = vi.fn();
  observe(read);
  navigation.dispatchEvent(
    Object.assign(navigationEvent(), { canIntercept: false, hashChange: true }),
  );
  navigation.commit("?/search&q=initial#anchor");
  flushSync();
  expect(read).toHaveBeenCalledTimes(1);
  navigation.commit("?unrouted=one&unrouted=two", false);
  flushSync();
  expect([...read.mock.lastCall![0]]).toEqual([
    ["unrouted", "one"],
    ["unrouted", "two"],
  ]);
});

it("shares one lazy listener, cleans up after the last reader, and reads fresh state on resubscription", async () => {
  const navigation = installNavigation("/search&q=initial");
  const add = vi.spyOn(navigation, "addEventListener");
  const remove = vi.spyOn(navigation, "removeEventListener");
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = observe(first);
  const stopSecond = observe(second);
  expect(add).toHaveBeenCalledTimes(1);
  expect(add.mock.calls[0][0]).toBe("currententrychange");
  navigation.commit("?/search&q=both");
  flushSync();
  expect(first.mock.lastCall![0].get("q")).toBe("both");
  expect(second.mock.lastCall![0].get("q")).toBe("both");
  stopFirst();
  await tick();
  expect(remove).not.toHaveBeenCalled();
  stopSecond();
  expect(remove).not.toHaveBeenCalled();
  await tick();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);
  navigation.commit("?/search&q=while-unsubscribed");
  const remounted = vi.fn();
  observe(remounted);
  expect(add).toHaveBeenCalledTimes(2);
  expect(remounted.mock.lastCall![0].get("q")).toBe("while-unsubscribed");
});
