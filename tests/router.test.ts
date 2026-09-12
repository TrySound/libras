// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteControls } from "../src/router.svelte";
import RouterTestApp from "./router-test-app.svelte";
import { installNavigation } from "./router-test-helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function setup(path = "/library") {
  const navigation = installNavigation(path);
  const target = document.createElement("main");
  document.body.append(target);
  let controls!: RouteControls;
  const component = mount(RouterTestApp, {
    target,
    props: { capture: (value) => (controls = value) },
  });
  cleanups.push(() => unmount(component));
  flushSync();
  target.querySelector("button")!.click();
  return { navigation, target, controls };
}

describe("router", () => {
  it.each(["reload", "push", "replace", "traverse"] as const)(
    "leaves reloads to the browser while routing hash navigation: %s",
    async (navigationType) => {
      const { navigation, target } = setup();
      const intercept = vi.fn((options: { handler: () => Promise<void>; scroll?: string }) =>
        options.handler(),
      );
      const event = new Event("navigate");
      Object.assign(event, {
        navigationType,
        canIntercept: true,
        destination: { url: new URL("#/player", window.location.href).href },
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
    ["/library/artist/artist-1/album/album-1", 'album:{"artistId":"artist-1","albumId":"album-1"}'],
    ["/unknown", "library:{}"],
  ])("renders the initial route %s with decoded parameters", (path, expected) => {
    const { target } = setup(path);
    expect(target.querySelector("p")!.textContent).toBe(expected);
  });

  it("builds hash links and navigates through the browser", () => {
    const { controls, navigation } = setup();
    expect(controls.href("/player")).toBe("#/player");
    controls.navigate("/player");
    expect(navigation.navigate).toHaveBeenCalledWith("#/player", { history: "push" });
    controls.navigate("/library", "replace");
    expect(navigation.navigate).toHaveBeenLastCalledWith("#/library", { history: "replace" });
  });

  it.each(["", "section"])("replaces an initial non-route hash: %s", (path) => {
    const { navigation, target } = setup(path);
    expect(navigation.navigate).toHaveBeenCalledWith("#/library", { history: "replace" });
    expect(target.querySelector("p")!.textContent).toBe("library:{}");
  });

  it.each([
    { canIntercept: false, destination: "#/player" },
    { canIntercept: true, destination: "https://external.example/#/player" },
    { canIntercept: true, destination: "#section" },
  ])("leaves unsupported navigation to the browser: %j", ({ canIntercept, destination }) => {
    const { navigation, target } = setup();
    const intercept = vi.fn();
    const event = new Event("navigate");
    Object.assign(event, {
      navigationType: "push",
      canIntercept,
      destination: { url: new URL(destination, window.location.href).href },
      intercept,
    });
    navigation.dispatchEvent(event);
    expect(intercept).not.toHaveBeenCalled();
    expect(target.querySelector("p")!.textContent).toBe("library:{}");
  });

  it("handles rejected navigation promises", async () => {
    const { controls, navigation } = setup();
    const finished = Promise.reject(new DOMException("Navigation aborted", "AbortError"));
    const caught = vi.spyOn(finished, "catch");
    navigation.navigate.mockReturnValueOnce({ finished });
    controls.navigate("/player");
    expect(caught).toHaveBeenCalledOnce();
    await expect(caught.mock.results[0].value).resolves.toBeUndefined();
  });

  it("removes the navigation listener on unmount", async () => {
    const { navigation } = setup();
    const remove = vi.spyOn(navigation, "removeEventListener");
    await cleanups.pop()!();
    expect(remove).toHaveBeenCalledWith("navigate", expect.any(Function));
  });
});
