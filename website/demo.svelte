<script lang="ts">
  import App from "../src/app.svelte";
  import { AuthStore } from "../src/auth";
  import { Network } from "../src/network.svelte";
  import { DeezerSubsonicClient } from "./deezer-client";

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
  const auth = new AuthStore(new MemoryStorage());
  // Public synthetic identity; its URL isolates the demo's OPFS account.
  auth.save({
    host: base.href.replace(/\/$/, ""),
    username: "deezer-preview-demo",
    token: "local-demo",
    salt: "local-demo",
  });
  const network = new Network((identity) => {
    if (
      identity.host !== base.href.replace(/\/$/, "") ||
      identity.username !== "deezer-preview-demo"
    ) {
      throw new Error("This demo is fixed to its local library. Reload the demo to reconnect.");
    }
    return new DeezerSubsonicClient(identity);
  });
</script>

<App {network} {auth} updaterComponent={undefined}>
  {#snippet settingsContent()}
    <article class="card stack-md" aria-labelledby="demo-credits-title">
      <h2 class="heading-md uppercase" id="demo-credits-title">Demo music credits</h2>
      <p class="body">Previews provided by Deezer. Downloads may not work in this demo.</p>
      <p class="body">
        <a href="https://www.deezer.com/album/302117" rel="noreferrer"
          >A Perfect Circle — Mer De Noms</a
        >
      </p>
      <ul class="stack-sm">
        <li><a href="https://www.deezer.com/track/3135439" rel="noreferrer">The Hollow</a></li>
        <li>
          <a href="https://www.deezer.com/track/3135442" rel="noreferrer">Judith (explicit)</a>
        </li>
        <li><a href="https://www.deezer.com/track/3135444" rel="noreferrer">3 Libras</a></li>
      </ul>
    </article>
  {/snippet}
</App>
