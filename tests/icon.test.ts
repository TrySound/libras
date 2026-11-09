// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Icon from "../src/icon.svelte";

it("renders a decorative icon using the inline sprite", async () => {
  const target = document.createElement("div");
  const component = mount(Icon, {
    target,
    props: { name: "play", size: "lg", class: "text-subtle" },
  });
  try {
    flushSync();
    const svg = target.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.getAttribute("height")).toBe("40");
    expect(svg.classList.contains("text-subtle")).toBe(true);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("use")?.getAttribute("href")).toBe("#icon-play");
    expect(svg.querySelector("path, symbol")).toBeNull();
  } finally {
    await unmount(component);
  }
});

it.each([
  [undefined, "24"],
  ["md", "24"],
  ["lg", "40"],
  ["xl", "96"],
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

it("allows a semantic status color", async () => {
  const target = document.createElement("div");
  const component = mount(Icon, {
    target,
    props: { name: "check", color: "var(--accent)" },
  });
  try {
    flushSync();
    expect(target.querySelector("svg")?.getAttribute("color")).toBe("var(--accent)");
    expect(target.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
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
  expect(names.map((name) => `icon-${name}`).sort()).toEqual(symbols.sort());
});

it("eases sound bars with sine splines while preserving periods, offsets and linear rotation", () => {
  const target = document.createElement("div");
  target.innerHTML = readFileSync("src/sprite.svg", "utf8");
  const bars = [...target.querySelectorAll("#icon-sound-bars animate")];
  expect(bars).toHaveLength(6);
  for (const [index, bar] of bars.entries()) {
    expect(bar.getAttribute("calcMode")).toBe("spline");
    expect(bar.getAttribute("keyTimes")).toBe("0;0.5;1");
    expect(bar.getAttribute("keySplines")).toBe("0.445 0.05 0.55 0.95;0.445 0.05 0.55 0.95");
    expect(bar.getAttribute("dur")).toBe("650ms");
    expect(bar.getAttribute("begin")).toBe(
      [null, null, "-420ms", "-420ms", "-210ms", "-210ms"][index],
    );
    expect(bar.getAttribute("repeatCount")).toBe("indefinite");
  }
  const spinner = target.querySelector("#icon-loading animateTransform")!;
  // SMIL's default calcMode is linear; keep constant angular velocity.
  expect(spinner.hasAttribute("calcMode")).toBe(false);
  expect(spinner.hasAttribute("keySplines")).toBe(false);
  expect(spinner.getAttribute("dur")).toBe("900ms");
  expect(spinner.getAttribute("from")).toBe("0 12 12");
  expect(spinner.getAttribute("to")).toBe("360 12 12");
});
