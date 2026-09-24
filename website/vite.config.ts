import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { inlineSvgSprite } from "../build/inline-svg-sprite.ts";

export default defineConfig({
  base: process.env.DEMO_BASE_PATH ?? "/",
  plugins: [inlineSvgSprite(), svelte()],
});
