import { afterEach, expect, it, vi } from "vitest";
import { immediateCover, lazyCover } from "../src/cover.svelte";
import { nearViewport } from "../src/viewport";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function mockObserver() {
  let callback: IntersectionObserverCallback;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  const construct = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback, options: IntersectionObserverInit) {
        construct();
        callback = cb;
        expect(options.rootMargin).toBe("600px 0px");
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  return {
    observe,
    unobserve,
    disconnect,
    construct,
    emit(target: Element, isIntersecting: boolean) {
      callback!(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    },
  };
}

it("shares observation, loads on entry and re-entry, and cleans up each target", () => {
  const observer = mockObserver();
  const first = { load: vi.fn() };
  const second = { load: vi.fn() };
  const one = {} as Element;
  const two = {} as Element;
  const cleanupOne = lazyCover(first)(one)!;
  const cleanupTwo = lazyCover(second)(two)!;
  cleanups.push(cleanupOne, cleanupTwo);
  expect(observer.construct).toHaveBeenCalledOnce();
  expect(observer.observe.mock.calls).toEqual([[one], [two]]);
  expect(first.load).not.toHaveBeenCalled();
  observer.emit(one, false);
  expect(first.load).not.toHaveBeenCalled();
  observer.emit(one, true);
  observer.emit(one, true);
  expect(first.load).toHaveBeenCalledOnce();
  expect(second.load).not.toHaveBeenCalled();
  expect(observer.disconnect).not.toHaveBeenCalled();
  observer.emit(one, false);
  expect(first.load).toHaveBeenCalledOnce();
  observer.emit(one, true);
  expect(first.load).toHaveBeenCalledTimes(2);
  cleanupOne();
  expect(observer.unobserve).toHaveBeenCalledWith(one);
  expect(observer.disconnect).not.toHaveBeenCalled();
  observer.emit(one, false);
  observer.emit(one, true);
  expect(first.load).toHaveBeenCalledTimes(2);
  observer.emit(two, true);
  expect(second.load).toHaveBeenCalledOnce();
  cleanupTwo();
  cleanupTwo();
  expect(observer.unobserve).toHaveBeenCalledTimes(2);
  expect(observer.disconnect).toHaveBeenCalledOnce();

  cleanups.push(lazyCover(first)({} as Element)!);
  expect(observer.construct).toHaveBeenCalledTimes(2);
});

it("reports both visibility transitions without repeating unchanged states", () => {
  const observer = mockObserver();
  const notify = vi.fn();
  const node = {} as Element;
  cleanups.push(nearViewport(notify)(node)!);
  observer.emit(node, false);
  observer.emit(node, false);
  observer.emit(node, true);
  observer.emit(node, true);
  observer.emit(node, false);
  expect(notify.mock.calls).toEqual([[false], [true], [false]]);
});

it("loads immediately when IntersectionObserver is unavailable", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const cover = { load: vi.fn() };
  lazyCover(cover)({} as Element);
  expect(cover.load).toHaveBeenCalledOnce();
});

it("loads prominent artwork immediately without observing", () => {
  const observer = vi.fn();
  vi.stubGlobal("IntersectionObserver", observer);
  const cover = { load: vi.fn() };
  immediateCover(cover)({} as Element);
  expect(cover.load).toHaveBeenCalledOnce();
  expect(observer).not.toHaveBeenCalled();
});
