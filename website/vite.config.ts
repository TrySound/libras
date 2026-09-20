import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const appHtml = fileURLToPath(new URL("../index.html", import.meta.url));

// Separate configuration deliberately has no PWA plugin or virtual register module.
export default defineConfig({
  root,
  base: process.env.DEMO_BASE_PATH ?? "/libras/demo/",
  publicDir: fileURLToPath(new URL("public", import.meta.url)),
  plugins: [
    svelte(),
    {
      name: "shared-app-icons",
      transformIndexHtml(html) {
        const source = readFileSync(appHtml, "utf8");
        const sprite = source.match(/<svg\b[^>]*aria-hidden="true"[\s\S]*?<\/svg>/)?.[0];
        if (!sprite?.includes('id="icon-brand"'))
          throw new Error("Shared app icon sprite not found.");
        return html.replace("<!-- shared-icon-sprite -->", sprite);
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL("../dist/demo", import.meta.url)),
    emptyOutDir: true,
  },
});
