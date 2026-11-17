import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { Window } from "happy-dom";
import { createServer } from "vite";
import { inlineSvgSprite } from "../build/inline-svg-sprite";

it("injects local animated symbols once into both HTML entry points", async () => {
  const server = await createServer({
    configFile: false,
    base: "/libras/",
    plugins: [inlineSvgSprite()],
    server: { middlewareMode: true, watch: null },
  });
  const window = new Window({
    settings: { disableCSSFileLoading: true, disableJavaScriptEvaluation: true },
  });
  try {
    for (const page of ["index.html", "styleguide.html"]) {
      const html = await server.transformIndexHtml(`/${page}`, await readFile(page, "utf8"));
      const document = new window.DOMParser().parseFromString(html, "text/html");
      expect(document.querySelectorAll("[data-icon-sprite]")).toHaveLength(1);
      expect(document.querySelector("[data-icon-sprite]")!.hasAttribute("hidden")).toBe(true);
      const sprite = document.querySelector("[data-icon-sprite] svg")!;
      expect(sprite.querySelector("#icon-play")).not.toBeNull();
      expect(sprite.querySelectorAll("animate, animateTransform")).toHaveLength(0);
      expect(sprite.querySelector("#play, #loading, #sound-bars")).toBeNull();
      const source = await readFile("src/sprite.svg", "utf8");
      expect(sprite.querySelectorAll("symbol")).toHaveLength(
        [...source.matchAll(/<symbol\b/g)].length,
      );
    }
  } finally {
    await window.happyDOM.close();
    await server.close();
  }
});
