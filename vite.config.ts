import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        id: "/",
        name: "Music Web",
        short_name: "Music",
        description: "Your Navidrome music library, online and offline.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#10131a",
        background_color: "#10131a",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["index.html", "assets/*.{js,css}"],
        navigateFallback: "index.html",
        navigateFallbackAllowlist: [/^\/$/, /^\/index\.html$/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: false,
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
