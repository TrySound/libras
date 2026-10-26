// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Loader from "../src/ui/loader.svelte";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it.each([undefined, "lg"] as const)("renders the decorative %s loader immediately", (size) => {
  const target = document.createElement("div");
  const component = mount(Loader, { target, props: { size } });
  cleanups.push(() => unmount(component));
  flushSync();
  expect(target.querySelectorAll(".loader-bar")).toHaveLength(5);
  expect(target.querySelector(".loader")?.getAttribute("aria-hidden")).toBe("true");
  expect(target.querySelector(".loader")?.getAttribute("data-size")).toBe(size ?? null);
});
