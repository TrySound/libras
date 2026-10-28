// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { fromStore, writable } from "svelte/store";
import Artwork from "../src/ui/artwork.svelte";
import { Covers } from "../src/covers.svelte";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal("IntersectionObserver", undefined);
  const covers = new Covers({ cache: undefined });
  const sources = new SvelteMap<string, string>();
  const loads = new Map<string, () => void>();
  vi.spyOn(covers, "ensureCover").mockImplementation((id) => {
    if (id === undefined) throw new Error("Missing artwork ID");
    if (!loads.has(id)) loads.set(id, vi.fn());
    return {
      get source() {
        return sources.get(id);
      },
      load: loads.get(id)!,
    };
  });
  const store = writable<string | undefined>(undefined);
  const state = fromStore(store);
  const target = document.createElement("div");
  const component = mount(Artwork, {
    target,
    props: {
      covers,
      get id() {
        return state.current;
      },
      size: "sm",
      class: "only-desktop",
    },
  });
  flushSync();
  cleanups.push(async () => {
    await unmount(component);
    covers.destroy();
  });
  return {
    target,
    sources,
    loads,
    covers,
    set(id: string | undefined) {
      store.set(id);
      flushSync();
    },
  };
}

it("keeps missing artwork decorative and does not request an absent ID", () => {
  const { target, covers } = setup();
  const root = target.querySelector(".artwork")!;
  expect(root.classList.contains("only-desktop")).toBe(true);
  expect(root.getAttribute("data-size")).toBe("sm");
  expect(root.getAttribute("aria-hidden")).toBe("true");
  expect(root.querySelector("img")?.hidden).toBe(true);
  expect(root.querySelector("img")?.hasAttribute("src")).toBe(false);
  expect(root.querySelector("svg")?.classList.contains("artwork-placeholder")).toBe(true);
  expect(covers.ensureCover).not.toHaveBeenCalled();
});

it("updates a stable image node, clears missing sources, and delegates URL lifetime to Covers", () => {
  const { target, sources, loads, set } = setup();
  const image = target.querySelector("img")!;
  set("one");
  expect(loads.get("one")).toHaveBeenCalledOnce();
  sources.set("one", "blob:one");
  flushSync();
  expect(target.querySelector("img")).toBe(image);
  expect(image.getAttribute("src")).toBe("blob:one");
  expect(image.hidden).toBe(false);
  set("two");
  expect(image.hasAttribute("src")).toBe(false);
  expect(image.hidden).toBe(true);
  sources.set("one", "blob:stale");
  sources.set("two", "blob:two");
  flushSync();
  expect(image.getAttribute("src")).toBe("blob:two");
  expect(target.querySelector("img")).toBe(image);
  set(undefined);
  expect(image.hidden).toBe(true);
  expect(image.hasAttribute("src")).toBe(false);
});
