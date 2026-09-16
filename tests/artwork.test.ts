// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { fromStore, writable } from "svelte/store";
import { SvelteMap } from "svelte/reactivity";
import Artwork from "../src/artwork.svelte";
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
      get variant() {
        return state.current.variant;
      },
      get size() {
        return state.current.size;
      },
      get iconSize() {
        return state.current.iconSize;
      },
      get viewTransitionName() {
        return state.current.viewTransitionName;
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
  it("lazily acquires an artwork ID and reacts to its source without reobserving", () => {
    const { target, loads, sources, observe, intersect } = setup();
    const load = loads.get("a")!;
    expect(load).not.toHaveBeenCalled();
    expect(target.querySelector("svg")).not.toBeNull();
    expect(target.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    intersect(false);
    expect(load).not.toHaveBeenCalled();
    intersect(true);
    expect(load).toHaveBeenCalledOnce();
    sources.set("a", "blob:cover");
    flushSync();
    expect(target.querySelector("img")?.getAttribute("src")).toBe("blob:cover");
    expect(target.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(target.querySelector("svg")).toBeNull();
    expect(observe).toHaveBeenCalledOnce();
    intersect(false);
    intersect(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads prominent artwork immediately without observing", () => {
    const { target, loads, sources, observer } = setup({ loading: "eager", variant: "artwork" });
    expect(target.querySelector(".artwork svg")?.getAttribute("width")).toBe("64");
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
    const { target, ensureCover, observer } = setup({ id: undefined, variant: "artwork" });
    expect(target.querySelector("svg")).not.toBeNull();
    expect(ensureCover).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("rebinds acquisition on artwork ID changes and cleans up on teardown", async () => {
    const { set, intersect, loads, sources, target, unobserve, destroy, disconnect } = setup();
    intersect(true);
    sources.set("a", "blob:old");
    flushSync();
    set({ id: "b" });
    sources.set("a", "blob:late");
    flushSync();
    expect(unobserve).toHaveBeenCalledOnce();
    expect(target.querySelector("img")).toBeNull();
    expect(loads.get("b")).not.toHaveBeenCalled();
    intersect(true);
    expect(loads.get("b")).toHaveBeenCalledOnce();
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
    expect(target.querySelector("img")).toBeNull();
    expect(target.querySelector("svg")).not.toBeNull();
    expect(loads.get("a")).toHaveBeenCalledOnce();
    set({ id: "b" });
    expect(loads.get("b")).toHaveBeenCalledOnce();
  });

  it("preserves styling and escapes view-transition names", () => {
    const { target, set } = setup({ variant: "tile", viewTransitionName: "artist-cover-a b" });
    const root = target.firstElementChild as HTMLElement;
    expect(root.className).toBe("tile-image");
    expect(root.style.viewTransitionName).toBe(CSS.escape("artist-cover-a b"));
    set({ variant: "cover", size: "sm", viewTransitionName: undefined, iconSize: 32 });
    expect(root.className).toBe("cover");
    expect(root.dataset.size).toBe("sm");
    expect(root.style.viewTransitionName).toBe("");
    expect(root.querySelector("svg")?.getAttribute("width")).toBe("32");
  });
});
