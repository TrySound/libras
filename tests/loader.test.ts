// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";
import Icon from "../src/icon.svelte";

it.each([
  [undefined, "24"],
  ["md", "24"],
  ["lg", "40"],
  ["xl", "96"],
] as const)("renders sprite loader size=%s", async (size, pixels) => {
  const target = document.createElement("div");
  const component = mount(Icon, { target, props: { name: "loader", size } });
  flushSync();
  try {
    const loader = target.querySelector("svg")!;
    expect(loader.getAttribute("aria-hidden")).toBe("true");
    expect(loader.getAttribute("width")).toBe(pixels);
    expect(loader.getAttribute("height")).toBe(pixels);
    expect(loader.querySelector("use")?.getAttribute("href")).toBe("#icon-loader");
  } finally {
    await unmount(component);
  }
});
