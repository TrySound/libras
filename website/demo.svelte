<script lang="ts">
  import App from "../src/app.svelte";
  import { AuthStore } from "../src/auth";
  import { Network } from "../src/network.svelte";
  import { StaticSubsonicClient } from "./client";

  class MemoryStorage implements Storage {
    private items = new Map<string, string>();

    get length() {
      return this.items.size;
    }
    key(index: number) {
      return [...this.items.keys()][index] ?? null;
    }
    getItem(key: string) {
      return this.items.get(String(key)) ?? null;
    }
    setItem(key: string, value: string) {
      this.items.set(String(key), String(value));
    }
    removeItem(key: string) {
      this.items.delete(String(key));
    }
    clear() {
      this.items.clear();
    }
  }

  const base = new URL(import.meta.env.BASE_URL, location.origin);
  const catalogBase = new URL("catalog/", base);
  const auth = new AuthStore(new MemoryStorage());
  // Public synthetic identity; its URL isolates the demo's OPFS account.
  auth.save({
    host: base.href.replace(/\/$/, ""),
    username: "static-demo",
    token: "local-demo",
    salt: "local-demo",
  });
  const network = new Network((identity) => {
    if (identity.host !== base.href.replace(/\/$/, "") || identity.username !== "static-demo") {
      throw new Error("This demo is fixed to its local library. Reload the demo to reconnect.");
    }
    return new StaticSubsonicClient(identity, catalogBase);
  });
</script>

<App {network} {auth} updaterComponent={undefined} />
