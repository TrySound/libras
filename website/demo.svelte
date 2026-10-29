<script lang="ts">
  import App from "../src/app.svelte";
  import { AuthStore } from "../src/auth";
  import { Network } from "../src/network.svelte";
  import { DeezerSubsonicClient } from "./deezer-client";
  import { demoAlbums } from "./deezer-catalog";

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
      <ul class="stack-sm body">
        {#each demoAlbums as album (album.id)}
          <li>
            <a href={`https://www.deezer.com/album/${album.id}`} rel="noreferrer">
              {album.artist} — {album.title} ({album.year})
            </a>
          </li>
        {/each}
      </ul>
    </article>
  {/snippet}
</App>
