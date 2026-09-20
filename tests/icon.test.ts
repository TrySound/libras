// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Icon from "../src/icon.svelte";
import spriteUrl from "../src/sprite.svg?url&no-inline";

it("renders a decorative icon using the external sprite URL", async () => {
  const target = document.createElement("div");
  const component = mount(Icon, {
    target,
    props: { name: "play", size: "lg", class: "text-danger" },
  });
  try {
    flushSync();
    const svg = target.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("class")).toBe("text-danger");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("use")?.getAttribute("href")).toBe(`${spriteUrl}#play`);
    expect(svg.querySelector("path, symbol")).toBeNull();
  } finally {
    await unmount(component);
  }
});

it.each([
  [undefined, "20"],
  ["md", "20"],
  ["lg", "32"],
  ["xl", "64"],
] as const)("renders size %s at %s pixels", async (size, pixels) => {
  const target = document.createElement("div");
  const component = mount(Icon, { target, props: { name: "music", size } });
  try {
    flushSync();
    const svg = target.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe(pixels);
    expect(svg.getAttribute("height")).toBe(pixels);
  } finally {
    await unmount(component);
  }
});

it("keeps the typed icon names in sync with the sprite symbols", () => {
  const sprite = readFileSync("src/sprite.svg", "utf8");
  const component = readFileSync("src/icon.svelte", "utf8");
  const symbols = [...sprite.matchAll(/<symbol\s+id="([^"]+)"/g)].map((match) => match[1]);
  const nameType = component.match(/export type IconName =([^;]+);/)![1];
  const names = [...nameType.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  expect(names.sort()).toEqual(symbols.sort());
});
