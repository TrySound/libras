// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import Delayed from "../src/ui/delayed.svelte";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function setup(when = false, fallback = false) {
  const store = writable({ when, delay: 300 });
  const state = fromStore(store);
  const target = document.createElement("div");
  const component = mount(Delayed, {
    target,
    props: {
      get when() {
        return state.current.when;
      },
      get delay() {
        return state.current.delay;
      },
      children: createRawSnippet(() => ({ render: () => "<span>Connecting…</span>" })),
      fallback: fallback
        ? createRawSnippet(() => ({ render: () => "<span>Connect</span>" }))
        : undefined,
    },
  });
  flushSync();
  let mounted = true;
  const destroy = async () => {
    if (!mounted) return;
    mounted = false;
    await unmount(component);
  };
  cleanups.push(destroy);
  const set = (values: Partial<{ when: boolean; delay: number }>) => {
    store.update((previous) => ({ ...previous, ...values }));
    flushSync();
  };
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
  };
  return { target, set, advance, destroy };
}

it("delays the entire content, including its text, until the threshold", async () => {
  const { target, set, advance } = setup();
  await advance(500);
  expect(target.textContent).toBe("");
  set({ when: true });
  await advance(299);
  expect(target.textContent).toBe("");
  await advance(1);
  expect(target.textContent).toBe("Connecting…");
  set({ when: false });
  expect(target.textContent).toBe("");
});

it("cancels fast operations and gives later operations a fresh grace period", async () => {
  const { target, set, advance } = setup(true);
  await advance(100);
  set({ when: false });
  expect(vi.getTimerCount()).toBe(0);
  await advance(300);
  expect(target.textContent).toBe("");
  set({ when: true });
  await advance(299);
  expect(target.textContent).toBe("");
  await advance(1);
  expect(target.textContent).toBe("Connecting…");
});

it("keeps the fallback while idle and during the grace period", async () => {
  const { target, set, advance } = setup(false, true);
  expect(target.textContent).toBe("Connect");
  set({ when: true });
  await advance(299);
  expect(target.textContent).toBe("Connect");
  await advance(1);
  expect(target.textContent).toBe("Connecting…");
  set({ when: false });
  expect(target.textContent).toBe("Connect");
});

it("restarts the timer when the delay changes", async () => {
  const { target, set, advance } = setup(true);
  await advance(200);
  set({ delay: 500 });
  await advance(499);
  expect(target.textContent).toBe("");
  await advance(1);
  expect(target.textContent).toBe("Connecting…");
});

it("clears the timer when unmounted", async () => {
  const { target, destroy, advance } = setup(true);
  await advance(100);
  await destroy();
  expect(vi.getTimerCount()).toBe(0);
  await advance(300);
  expect(target.childElementCount).toBe(0);
});
