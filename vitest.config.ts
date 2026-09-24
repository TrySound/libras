import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "mock-pwa-register",
      resolveId(id) {
        if (id === "virtual:pwa-register") return id;
      },
    },
    svelte({
      dynamicCompileOptions: () => ({ generate: "client" }),
    }),
  ],
  resolve: { conditions: ["browser"] },
  ssr: { resolve: { conditions: ["browser"] }, noExternal: ["svelte"] },
  test: {
    // Use happy-dom's isolated browser storage, not Node's file-backed Web Storage.
    execArgv: ["--no-experimental-webstorage"],
    include: ["tests/**/*.test.ts", "website/**/*.test.ts"],
    server: { deps: { inline: ["svelte"] } },
  },
});
