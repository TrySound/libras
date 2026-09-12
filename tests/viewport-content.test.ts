// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { viewportContent } from "../src/viewport";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function setup() {
  let callback: IntersectionObserverCallback;
  const unobserve = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe = vi.fn();
      unobserve = unobserve;
      disconnect = vi.fn();
    },
  );
  const tile = document.createElement("a");
  tile.href = "#artist";
  document.body.append(tile);
  const hidden = () => tile.hasAttribute("data-viewport-hidden");
  const load = vi.fn(() => expect(hidden()).toBe(false));
  const cleanup = viewportContent(load)(tile)!;
  cleanups.push(cleanup);
  return {
    tile,
    load,
    hidden,
    cleanup,
    unobserve,
    intersect(isIntersecting: boolean) {
      callback!(
        [{ target: tile, isIntersecting } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    },
  };
}

it("reveals the entire tile before acquiring artwork and hides it on exit", () => {
  const { hidden, load, intersect } = setup();
  expect(hidden()).toBe(true);
  expect(load).not.toHaveBeenCalled();
  intersect(false);
  expect(load).not.toHaveBeenCalled();
  intersect(true);
  expect(hidden()).toBe(false);
  expect(load).toHaveBeenCalledOnce();
  intersect(true);
  expect(load).toHaveBeenCalledOnce();
  intersect(false);
  expect(hidden()).toBe(true);
  expect(load).toHaveBeenCalledOnce();
  intersect(true);
  expect(hidden()).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
});

it("reveals focused tiles and only hides them after focus leaves", async () => {
  const { tile, hidden, load, intersect } = setup();
  tile.focus();
  expect(hidden()).toBe(false);
  expect(load).toHaveBeenCalledOnce();
  intersect(true);
  intersect(false);
  expect(hidden()).toBe(false);
  expect(load).toHaveBeenCalledOnce();
  tile.blur();
  await Promise.resolve();
  expect(hidden()).toBe(true);
});

it("cleanup removes observation, hiding and focus handlers, including pending updates", async () => {
  const { tile, hidden, load, cleanup, unobserve, intersect } = setup();
  tile.focus();
  tile.blur();
  cleanup();
  await Promise.resolve();
  expect(hidden()).toBe(false);
  expect(unobserve).toHaveBeenCalledExactlyOnceWith(tile);
  intersect(true);
  tile.focus();
  expect(load).toHaveBeenCalledOnce();
});

it("shows content and acquires artwork without observer support", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const tile = document.createElement("a");
  const load = vi.fn();
  cleanups.push(viewportContent(load)(tile)!);
  expect(tile.hasAttribute("data-viewport-hidden")).toBe(false);
  expect(load).toHaveBeenCalledOnce();
});
