import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.DEMO_BASE_PATH ?? "/libras/demo/",
  plugins: [svelte()],
});
