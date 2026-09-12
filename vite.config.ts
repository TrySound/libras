import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const base = process.env.BASE_PATH ?? "/";
const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default defineConfig({
  base,
  plugins: [
    svelte(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        id: base,
        name: "Libras",
        short_name: "Libras",
        description: "Your Navidrome music library, online and offline.",
        start_url: base,
        scope: base,
        display: "standalone",
        theme_color: "#10131a",
        background_color: "#10131a",
        icons: [
          { src: `${base}icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
          { src: `${base}icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: `${base}icons/icon-maskable-512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: [
          "index.html",
          "assets/*.{js,css}",
          "favicon.ico",
          "icon.svg",
          "apple-touch-icon.png",
          "icons/*.png",
        ],
        navigateFallback: `${base}index.html`,
        navigateFallbackAllowlist: [new RegExp(`^${escapedBase}(?:index\\.html)?$`)],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        app: "index.html",
        styleguide: "styleguide.html",
      },
    },
  },
});
