// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { fromStore, writable } from "svelte/store";
import { SvelteMap } from "svelte/reactivity";
import Artwork from "../src/ui/artwork.svelte";
import { Covers } from "../src/covers.svelte";
import { TestSelection } from "./cache-selection-test-helpers.svelte";

type Props = ComponentProps<typeof Artwork>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(overrides: Partial<Props> = {}, observation = true) {
  const covers = new Covers(new TestSelection());
  const sources = new SvelteMap<string, string>();
  const loads = new Map<string, ReturnType<typeof vi.fn>>();
  const handles = new Map<string, { readonly source: string | undefined; load(): void }>();
  const handle = (key: string) => {
    if (!handles.has(key)) {
      const load = vi.fn();
      loads.set(key, load);
      handles.set(key, {
        get source() {
          return sources.get(key);
        },
        load,
      });
    }
    return handles.get(key)!;
  };
  const ensureCover = vi.spyOn(covers, "ensureCover").mockImplementation((id) => handle(id!));
  let notify: IntersectionObserverCallback;
  const observed = new Set<Element>();
  const observe = vi.fn((node: Element) => {
    observed.add(node);
  });
  const unobserve = vi.fn((node: Element) => {
    observed.delete(node);
  });
  const disconnect = vi.fn(() => observed.clear());
  const observer = vi.fn(function (callback: IntersectionObserverCallback) {
    notify = callback;
    return { observe, unobserve, disconnect };
  });
  vi.stubGlobal("IntersectionObserver", observation ? observer : undefined);
  const store = writable<Props>({ covers, id: "a", ...overrides });
  const state = fromStore(store);
  const target = document.createElement("div");
  const component = mount(Artwork, {
    target,
    props: {
      get covers() {
        return state.current.covers;
      },
      get id() {
        return state.current.id;
      },
      get loading() {
        return state.current.loading;
      },
      get size() {
        return state.current.size;
      },
      get class() {
        return state.current.class;
      },
    },
  });
  flushSync();
  let mounted = true;
  const destroy = async () => {
    if (!mounted) return;
    mounted = false;
    await unmount(component);
    covers.destroy();
  };
  cleanups.push(destroy);
  return {
    target,
    covers,
    sources,
    loads,
    ensureCover,
    observe,
    unobserve,
    disconnect,
    observer,
    destroy,
    set(patch: Partial<Props>) {
      store.update((props) => ({ ...props, ...patch }));
      flushSync();
    },
    intersect(visible: boolean) {
      notify(
        [...observed].map(
          (node) => ({ target: node, isIntersecting: visible }) as IntersectionObserverEntry,
        ),
        {} as IntersectionObserver,
      );
      flushSync();
    },
  };
}

describe("Artwork", () => {
  it.each(["sm", "md", "cover"] as const)("uses the shared artwork class for %s", (size) => {
    const { target } = setup({ size });
    const root = target.firstElementChild!;
    expect(root.className).toBe("artwork");
    expect(root.getAttribute("data-size")).toBe(size);
    expect(root.querySelector("svg")?.getAttribute("width")).toBe(size === "cover" ? "96" : "20");
  });

  it("lazily acquires an artwork ID and reacts to its source without reobserving", () => {
    const { target, loads, sources, observe, intersect } = setup();
    const load = loads.get("a")!;
    const image = target.querySelector("img")!;
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute("src")).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(target.querySelector("svg")).not.toBeNull();
    expect(target.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    intersect(false);
    expect(load).not.toHaveBeenCalled();
    intersect(true);
    expect(load).toHaveBeenCalledOnce();
    sources.set("a", "blob:cover");
    flushSync();
    expect(target.querySelector("img")).toBe(image);
    expect(image.getAttribute("src")).toBe("blob:cover");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.hidden).toBe(false);
    expect(target.querySelector("svg")).not.toBeNull();
    expect(observe).toHaveBeenCalledOnce();
    intersect(false);
    intersect(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads prominent artwork immediately without observing", () => {
    const { target, loads, sources, observer } = setup({ loading: "eager", size: "cover" });
    expect(target.querySelector(".artwork svg")?.getAttribute("width")).toBe("96");
    sources.set("a", "blob:cover");
    flushSync();
    expect(target.querySelector("img")?.getAttribute("src")).toBe("blob:cover");
    expect(loads.get("a")).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
  });

  it("falls back to immediate acquisition without IntersectionObserver", () => {
    const { loads } = setup({}, false);
    expect(loads.get("a")).toHaveBeenCalledOnce();
  });

  it("renders an empty player placeholder without requesting or observing a missing ID", () => {
    const { target, ensureCover, observer } = setup({
      id: undefined,
      size: "cover",
      class: "only-desktop",
    });
    const root = target.querySelector(".artwork")!;
    expect(root.classList.contains("only-desktop")).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("img")?.hidden).toBe(true);
    expect(root.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(root.querySelector("svg")?.classList.contains("artwork-placeholder")).toBe(true);
    expect(ensureCover).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("rebinds acquisition on artwork ID changes and cleans up on teardown", async () => {
    const { set, intersect, loads, sources, target, unobserve, destroy, disconnect } = setup();
    const image = target.querySelector("img")!;
    intersect(true);
    sources.set("a", "blob:old");
    flushSync();
    set({ id: "b" });
    sources.set("a", "blob:late");
    flushSync();
    expect(unobserve).toHaveBeenCalledOnce();
    expect(target.querySelector("img")?.hidden).toBe(true);
    expect(loads.get("b")).not.toHaveBeenCalled();
    intersect(true);
    expect(loads.get("b")).toHaveBeenCalledOnce();
    sources.set("b", "blob:new");
    flushSync();
    expect(target.querySelector("img")).toBe(image);
    expect(image.getAttribute("src")).toBe("blob:new");
    expect(loads.get("a")).toHaveBeenCalledOnce();
    await destroy();
    expect(unobserve).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalled();
  });

  it("switches to eager acquisition and stops acquiring when the ID disappears", () => {
    const { set, loads, sources, target, unobserve } = setup();
    set({ loading: "eager" });
    expect(unobserve).toHaveBeenCalledOnce();
    expect(loads.get("a")).toHaveBeenCalledOnce();
    sources.set("a", "blob:old");
    flushSync();
    set({ id: undefined });
    expect(target.querySelector("img")?.hidden).toBe(true);
    expect(target.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(target.querySelector("svg")).not.toBeNull();
    expect(loads.get("a")).toHaveBeenCalledOnce();
    set({ id: "b" });
    expect(loads.get("b")).toHaveBeenCalledOnce();
  });

  it("preserves styling without shared-element transitions", () => {
    const { target, set } = setup({ size: "cover" });
    const root = target.firstElementChild as HTMLElement;
    expect(root.className).toBe("artwork");
    expect(root.dataset.size).toBe("cover");
    expect(root.style.viewTransitionName).toBe("");
    expect(root.querySelector("svg")?.getAttribute("width")).toBe("96");
    set({ size: "sm" });
    expect(root.className).toBe("artwork");
    expect(root.dataset.size).toBe("sm");
    expect(root.style.viewTransitionName).toBe("");
    expect(root.querySelector("svg")?.getAttribute("width")).toBe("20");
  });
});
