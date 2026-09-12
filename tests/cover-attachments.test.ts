import { afterEach, expect, it, vi } from "vitest";
import { immediateCover, lazyCover } from "../src/cover.svelte";

afterEach(() => vi.unstubAllGlobals());

it("requests artwork near the viewport and disconnects on cleanup", () => {
  let callback: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback, options: IntersectionObserverInit) {
        callback = cb;
        expect(options.rootMargin).toBe("200px");
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const cover = { load: vi.fn() };
  const node = {} as Element;
  const cleanup = lazyCover(cover)(node);
  expect(observe).toHaveBeenCalledWith(node);
  expect(cover.load).not.toHaveBeenCalled();
  callback!([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(cover.load).not.toHaveBeenCalled();
  callback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(cover.load).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  cleanup?.();
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it("loads prominent artwork immediately without observing", () => {
  const observer = vi.fn();
  vi.stubGlobal("IntersectionObserver", observer);
  const cover = { load: vi.fn() };
  immediateCover(cover)({} as Element);
  expect(cover.load).toHaveBeenCalledOnce();
  expect(observer).not.toHaveBeenCalled();
});
