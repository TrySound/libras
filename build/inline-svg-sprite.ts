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
      // Keep the SVG rendered (not display:none) for animated <use> instances.
      const inline = sprite.replace(
        "<svg ",
        '<svg aria-hidden="true" focusable="false" width="0" height="0" style="position:absolute;overflow:hidden;pointer-events:none" ',
      );
      return [
        {
          tag: "div",
          attrs: { "data-icon-sprite": true },
          children: inline,
          injectTo: "body-prepend",
        },
      ];
    },
  };
}
