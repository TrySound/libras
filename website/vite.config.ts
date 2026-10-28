import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, normalizePath } from "vite";
import { fileURLToPath } from "node:url";
import { inlineSvgSprite } from "../build/inline-svg-sprite.ts";

export default defineConfig({
  base: process.env.DEMO_BASE_PATH ?? "/",
  build: {
    rolldownOptions: {
      input: {
        website: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo/index.html", import.meta.url)),
      },
    },
  },
  plugins: [
    inlineSvgSprite(),
    svelte(),
    {
      name: "shared-font-preloads",
      apply: "serve",
      transformIndexHtml(html, context) {
        // HTML-relative paths outside the website root need the same /@fs URL
        // used by the shared font CSS in development. Builds emit hashed URLs.
        const directory = normalizePath(fileURLToPath(new URL("../src/fonts/", import.meta.url)));
        const prefix = `${context.server!.config.base}@fs/${directory.replace(/^\//, "")}`;
        return html.replace(/href="(?:\.\.\/)+src\/fonts\//g, `href="${prefix}`);
      },
    },
  ],
});
