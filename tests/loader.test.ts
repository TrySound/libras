// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Loader from "../src/ui/loader.svelte";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function setup(delay?: number) {
  const target = document.createElement("div");
  const component = mount(Loader, { target, props: { delay } });
  flushSync();
  let mounted = true;
  const destroy = async () => {
    if (!mounted) return;
    mounted = false;
    await unmount(component);
  };
  cleanups.push(destroy);
  return { target, destroy };
}

it("renders the default loader immediately", () => {
  const { target } = setup();
  expect(target.querySelectorAll(".loader-bar")).toHaveLength(5);
  expect(target.querySelector(".loader")?.getAttribute("aria-hidden")).toBe("true");
});

it("reserves the same frame but mounts no bars until the grace period expires", async () => {
  vi.useFakeTimers();
  const { target } = setup(300);
  const frame = target.querySelector(".loader");
  expect(frame).not.toBeNull();
  expect(target.querySelectorAll(".loader-bar")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(299);
  flushSync();
  expect(target.querySelectorAll(".loader-bar")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  flushSync();
  expect(target.querySelector(".loader")).toBe(frame);
  expect(target.querySelectorAll(".loader-bar")).toHaveLength(5);
});

it("cancels delayed appearance when an operation finishes before the threshold", async () => {
  vi.useFakeTimers();
  const { target, destroy } = setup(300);
  await vi.advanceTimersByTimeAsync(100);
  await destroy();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(300);
  expect(target.childElementCount).toBe(0);
});
