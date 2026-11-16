// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { expect, it, vi } from "vitest";
import FavouriteButton from "../src/ui/favourite-button.svelte";
import type { Favourites } from "../src/favourites.svelte";
import type { Cache } from "../src/cache.svelte";

it("keeps mutation failures local to the captured engine, cache and target without focus effects", async () => {
  let reject!: (error: Error) => void;
  const toggle = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const engine = {
    available: true,
    outcomeUnknown: false,
    pending: new SvelteMap<string, boolean>(),
    key: (target: { id: string }) => target.id,
    has: () => false,
    targetError: () => "",
    toggle,
  } as unknown as Favourites;
  const firstCache = {} as Cache;
  const nextCache = {} as Cache;
  const state = new SvelteMap<string, unknown>([
    ["engine", engine],
    ["cache", firstCache],
    ["id", "A"],
  ]);
  const target = document.createElement("div");
  document.body.append(target);
  const input = document.createElement("input");
  target.append(input);
  const app = mount(FavouriteButton, {
    target,
    props: {
      get favourites() {
        return state.get("engine") as Favourites;
      },
      get cache() {
        return state.get("cache") as Cache;
      },
      get target() {
        const id = state.get("id") as string | undefined;
        return id === undefined ? undefined : { kind: "tracks" as const, id };
      },
      icon: true,
    },
  });
  flushSync();
  try {
    target.querySelector("button")!.click();
    expect(toggle).toHaveBeenCalledWith({ kind: "tracks", id: "A" });
    state.set("id", "B");
    flushSync();
    input.focus();
    reject(new Error("A rejected"));
    await Promise.resolve();
    flushSync();
    expect(target.textContent).not.toContain("A rejected");
    expect(document.activeElement).toBe(input);
    expect(target.querySelector("button")!.disabled).toBe(false);
    state.set("id", "A");
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("A rejected");
    });
    state.set("cache", nextCache);
    flushSync();
    expect(target.textContent).not.toContain("A rejected");
    state.set("cache", firstCache);
    state.set("engine", { ...engine });
    flushSync();
    expect(target.textContent).not.toContain("A rejected");
    state.set("engine", engine);
    flushSync();
    target.querySelector("button")!.click();
    reject(new DOMException("Retired", "AbortError"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.textContent).not.toContain("A rejected");
    expect(target.textContent).not.toContain("Retired");
    engine.pending.set("A", false);
    flushSync();
    expect(target.querySelector("button")!.disabled).toBe(true);
    expect(target.textContent).toContain("Removing from favourites…");
    target.querySelector("button")!.click();
    expect(toggle).toHaveBeenCalledTimes(2);
    state.delete("id");
    flushSync();
    expect(target.querySelector("button")!.disabled).toBe(true);
    expect(target.querySelector(".favourite-feedback")).toBeNull();
  } finally {
    await unmount(app);
    target.remove();
  }
});
