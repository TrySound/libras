import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function inlineSvgSprite(): Plugin {
  const spritePath = fileURLToPath(new URL("../src/sprite.svg", import.meta.url));

  return {
    name: "inline-svg-sprite",
    buildStart() {
      this.addWatchFile(spritePath);
    },
    handleHotUpdate({ file, server }) {
      if (file === spritePath) {
        server.ws.send({ type: "full-reload", path: "*" });
        return [];
      }
    },
    async transformIndexHtml() {
      const sprite = await readFile(spritePath, "utf8");
      return [
        {
          tag: "div",
          attrs: { "data-icon-sprite": true, hidden: true },
          children: sprite,
          injectTo: "body-prepend",
        },
      ];
    },
  };
}
