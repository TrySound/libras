// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { expect, it } from "vitest";
import Icon from "../src/icon.svelte";

it.each([undefined, "xl"] as const)("renders sprite loader size=%s", async (size) => {
  const target = document.createElement("div");
  const component = mount(Icon, { target, props: { name: "loader", size } });
  flushSync();
  try {
    const loader = target.querySelector("svg")!;
    expect(loader.style.getPropertyValue("--loader-gap")).toBe(
      size === "xl" ? "var(--space-xs, 4px)" : "",
    );
    expect(loader.querySelector("use")?.getAttribute("href")).toBe("#icon-loader");
  } finally {
    await unmount(component);
  }
});
