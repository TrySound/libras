// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route, isCurrentPage, navigate } from "../src/router.svelte";
import RouterTestApp from "./router-test-app.svelte";
import { installNavigation, navigationEvent } from "./router-test-helpers";

const originalStartViewTransition = document.startViewTransition;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.startViewTransition = originalStartViewTransition;
});

function setup(path = "/library", url?: string) {
  const navigation = installNavigation(path);
  if (url) window.history.replaceState(null, "", url);
  const target = document.createElement("main");
  document.body.append(target);
  const rendered: string[] = [];
  const component = mount(RouterTestApp, {
    target,
    props: {
      onRender(name) {
        rendered.push(name);
      },
    },
  });
  cleanups.push(() => unmount(component));
  flushSync();
  return { navigation, target, rendered };
}

describe("router", () => {
  it.each(["reload", "push", "replace", "traverse"] as const)(
    "leaves reloads to the browser while routing query navigation: %s",
    async (navigationType) => {
      const { navigation, target } = setup();
      const intercept = vi.fn((options: { handler: () => Promise<void>; scroll?: string }) =>
        options.handler(),
      );
      const event = navigationEvent();
      Object.assign(event, {
        navigationType,
        canIntercept: true,
        destination: { url: new URL("?/player", window.location.href).href },
        intercept,
      });
      navigation.dispatchEvent(event);
      if (navigationType === "reload") {
        expect(intercept).not.toHaveBeenCalled();
        expect(target.querySelector("p")!.textContent).toBe("library:{}");
      } else {
        expect(intercept).toHaveBeenCalledOnce();
        expect(intercept.mock.calls[0][0].scroll).toBeUndefined();
        await intercept.mock.results[0].value;
        expect(target.querySelector("p")!.textContent).toBe("player:{}");
      }
    },
  );

  it.each([
    ["/library", "library:{}"],
    ["/library/artist/artist%201", 'artist:{"artistId":"artist 1"}'],
    ["/library/artist/a%2Fb%3Fc%23d%26e%25", 'artist:{"artistId":"a/b?c#d&e%"}'],
    ["/library/artist/artist-1/album/album-1", 'album:{"artistId":"artist-1","albumId":"album-1"}'],
    ["/unknown", "library:{}"],
  ])("renders the initial route %s with decoded parameters", (path, expected) => {
    const { target, rendered } = setup(path);
    expect(target.querySelector("p")!.textContent).toBe(expected);
    expect(rendered).toEqual([expected.split(":")[0]]);
  });

  it.each([false, true])(
    "uses view transitions unless reduced motion is enabled: %s",
    async (reducedMotion) => {
      const { navigation, target } = setup();
      vi.spyOn(window, "matchMedia").mockReturnValue({ matches: reducedMotion } as MediaQueryList);
      const scroll = vi.fn(() => {
        expect(target.querySelector("p")!.textContent).toBe("player:{}");
      });
      const start = vi.fn((update: () => Promise<void>) => {
        expect(target.querySelector("p")!.textContent).toBe("library:{}");
        const done = Promise.resolve().then(update);
        return { updateCallbackDone: done, ready: done, finished: done, skipTransition: vi.fn() };
      });
      document.startViewTransition = start as unknown as typeof document.startViewTransition;
      let finished: Promise<void> | undefined;
      navigation.dispatchEvent(
        Object.assign(navigationEvent(), {
          navigationType: "push",
          canIntercept: true,
          destination: { url: new URL("?/player", window.location.href).href },
          scroll,
          intercept({ handler }: { handler: () => Promise<void> }) {
            // The browser commits the destination URL before running the handler.
            window.history.replaceState(null, "", "?/player");
            finished = handler();
          },
        }),
      );
      // Capture waits for pending Svelte updates rather than forcing a synchronous flush.
      expect(start).not.toHaveBeenCalled();
      await finished;
      expect(target.querySelector("p")!.textContent).toBe("player:{}");
      expect(start).toHaveBeenCalledTimes(reducedMotion ? 0 : 1);
      expect(scroll).toHaveBeenCalledTimes(reducedMotion ? 0 : 1);
    },
  );

  it("does not navigate to the current URL", () => {
    const navigation = installNavigation("/library");
    navigate("/library");
    navigate("/library", "replace");
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it.each(["", "#section"])(
    "does not animate same-URL events after native anchors: %s",
    async (hash) => {
      const { navigation } = setup();
      window.history.replaceState(null, "", `?/library${hash}`);
      const start = vi.fn();
      document.startViewTransition = start;
      const intercept = vi.fn((options: { handler: () => Promise<void> }) => options.handler());
      navigation.dispatchEvent(
        Object.assign(navigationEvent(), {
          navigationType: "replace",
          canIntercept: true,
          destination: { url: window.location.href },
          intercept,
        }),
      );
      await intercept.mock.results[0].value;
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("navigates through the browser with query paths", () => {
    const navigation = installNavigation("/library");
    navigate("/player");
    expect(navigation.navigate).toHaveBeenCalledWith("?/player", { history: "push" });
    navigate("/player", "replace");
    expect(navigation.navigate).toHaveBeenLastCalledWith("?/player", { history: "replace" });
  });

  it.each(["/webapp/", "/webapp/?section"])("renders the fallback without rewriting %s", (url) => {
    const { navigation, target } = setup("/library", url);
    expect(window.location.href).toBe(new URL(url, window.location.origin).href);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(route.pattern).toBe("/library");
    expect(target.querySelector("p")!.textContent).toBe("library:{}");
  });

  it.each([
    { canIntercept: false, destination: "?/player" },
    { canIntercept: true, destination: "https://external.example/?/player" },
    { canIntercept: true, destination: "/other/?/player" },
  ])("leaves unsupported navigation to the browser: %j", ({ canIntercept, destination }) => {
    const { navigation, target } = setup();
    const intercept = vi.fn();
    const event = navigationEvent();
    Object.assign(event, {
      navigationType: "push",
      canIntercept,
      destination: { url: new URL(destination, window.location.href).href },
      intercept,
    });
    navigation.dispatchEvent(event);
    expect(intercept).not.toHaveBeenCalled();
    expect(target.querySelector("p")!.textContent).toBe("library:{}");
    expect(route.pattern).toBe("/library");
  });

  it.each([
    { path: "/library", current: ["/library"], other: ["/lib", "/library/artist", "/settings"] },
    {
      path: "/library/artist/artist-1",
      current: ["/library", "/library/artist", "/library/artist/:artistId"],
      other: ["/lib", "/library/art", "/library/artists", "/settings"],
    },
    { path: "/unknown", current: ["/library"], other: ["/unknown", "/settings"] },
  ])(
    "identifies the current page and its parent sections for $path",
    ({ path, current, other }) => {
      setup(path);
      for (const destination of current) expect(isCurrentPage(destination)).toBe(true);
      for (const destination of other) expect(isCurrentPage(destination)).toBe(false);
    },
  );

  it("handles rejected navigation promises", async () => {
    const navigation = installNavigation("/library");
    const finished = Promise.reject(new DOMException("Navigation aborted", "AbortError"));
    const caught = vi.spyOn(finished, "catch");
    navigation.navigate.mockReturnValueOnce({ finished });
    navigate("/player");
    expect(caught).toHaveBeenCalledOnce();
    await expect(caught.mock.results[0].value).resolves.toBeUndefined();
  });

  it("publishes the route pattern and updates parameters within the same pattern", async () => {
    const { navigation, target } = setup("/unknown");
    const summary = target.querySelector<HTMLElement>("[data-route-pattern]")!;
    expect(summary.dataset.routePattern).toBe("/library");

    for (const id of ["artist%201", "artist%202"]) {
      const url = new URL(`?/library/artist/${id}`, window.location.href);
      const intercept = vi.fn((options: { handler: () => Promise<void> }) => options.handler());
      navigation.dispatchEvent(
        Object.assign(navigationEvent(), {
          navigationType: "push",
          canIntercept: true,
          destination: { url: url.href },
          intercept,
        }),
      );
      await intercept.mock.results[0].value;
      expect(summary.dataset.routePattern).toBe("/library/artist/:artistId");
      expect(target.querySelector("p")!.textContent).toBe(
        `artist:${JSON.stringify({ artistId: decodeURIComponent(id) })}`,
      );
    }
  });

  it("leaves route metadata unchanged for aborted navigation", async () => {
    const { navigation, target } = setup("/library");
    const summary = target.querySelector<HTMLElement>("[data-route-pattern]")!;
    const controller = new AbortController();
    controller.abort();
    const intercept = vi.fn((options: { handler: () => Promise<void> }) => options.handler());
    navigation.dispatchEvent(
      Object.assign(navigationEvent(), {
        navigationType: "push",
        canIntercept: true,
        signal: controller.signal,
        destination: { url: new URL("?/player", window.location.href).href },
        intercept,
      }),
    );
    await intercept.mock.results[0].value;
    expect(route.pattern).toBe("/library");
    expect(summary.dataset.routePattern).toBe("/library");
    expect(target.querySelector("p")!.textContent).toBe("library:{}");
  });

  it.each(["/webapp/", "/demo/"])("preserves the deployment path at %s", (base) => {
    const { navigation } = setup("/library", `${base}?/library`);
    navigate("/player");
    const href = navigation.navigate.mock.calls[0][0];
    expect(new URL(href, window.location.href).pathname).toBe(base);
  });

  it("preserves and scrolls to an initial anchor after rendering", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { target } = setup("/library", "/webapp/?/player#page%20heading");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.querySelector("p")!.textContent).toBe("player:{}");
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll.mock.instances[0]).toBe(target.querySelector("p"));
    expect(window.location.hash).toBe("#page%20heading");
  });

  it("retains anchors on the query-free root", () => {
    setup("/library", "/webapp/#page-heading");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#page-heading");
  });

  it("routes Back to the query-free root without a document reload", async () => {
    const { navigation, target } = setup("/player", "/webapp/?/player");
    const intercept = vi.fn((options: { handler: () => Promise<void> }) => options.handler());
    navigation.dispatchEvent(
      Object.assign(navigationEvent(), {
        navigationType: "traverse",
        canIntercept: true,
        destination: { url: new URL("/webapp/", window.location.origin).href },
        intercept,
      }),
    );
    await intercept.mock.results[0].value;
    expect(route.pattern).toBe("/library");
    expect(target.querySelector("p")!.textContent).toBe("library:{}");
  });

  it("leaves anchor traversal native without remounting or view transitions", () => {
    const { navigation, rendered } = setup();
    const intercept = vi.fn();
    const start = vi.fn();
    document.startViewTransition = start;
    for (const navigationType of ["push", "traverse"]) {
      navigation.dispatchEvent(
        Object.assign(navigationEvent(), {
          navigationType,
          canIntercept: true,
          hashChange: true,
          destination: { url: new URL("#section", window.location.href).href },
          intercept,
        }),
      );
    }
    expect(intercept).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(rendered).toEqual(["library"]);
  });

  it("routes a new page with an anchor before browser scroll handling", async () => {
    const { navigation, target } = setup();
    const url = new URL("?/player#page%20heading", window.location.href);
    const intercept = vi.fn((options: { handler: () => Promise<void> }) => options.handler());
    navigation.dispatchEvent(
      Object.assign(navigationEvent(), {
        navigationType: "push",
        canIntercept: true,
        destination: { url: url.href },
        intercept,
      }),
    );
    await intercept.mock.results[0].value;
    expect(target.querySelector("p")!.textContent).toBe("player:{}");
    expect(route.pattern).toBe("/player");
    expect(intercept.mock.calls[0][0]).not.toHaveProperty("scroll");
  });

  it("removes the navigation listener on unmount", async () => {
    const { navigation } = setup();
    const remove = vi.spyOn(navigation, "removeEventListener");
    await cleanups.pop()!();
    expect(remove).toHaveBeenCalledWith("navigate", expect.any(Function));
  });
});
