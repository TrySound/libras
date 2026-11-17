// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";
import Icon from "../src/icon.svelte";

it.each([
  [undefined, "md", "24"],
  ["md", "md", "24"],
  ["lg", "lg", "40"],
  ["xl", "xl", "96"],
] as const)("renders sprite loader size=%s", async (size, symbol, pixels) => {
  const target = document.createElement("div");
  const component = mount(Icon, { target, props: { name: "loader", size } });
  flushSync();
  try {
    const loader = target.querySelector("svg")!;
    expect(loader.getAttribute("aria-hidden")).toBe("true");
    expect(loader.getAttribute("width")).toBe(pixels);
    expect(loader.getAttribute("height")).toBe(pixels);
    expect(loader.querySelector("use")?.getAttribute("href")).toBe(`#icon-loader-${symbol}`);
  } finally {
    await unmount(component);
  }
});
