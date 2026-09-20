<script lang="ts">
  import { onMount } from "svelte";
  import App from "../src/app.svelte";
  import { AuthStore } from "../src/auth";
  import { Network } from "../src/network.svelte";
  import { loadCatalog, StaticSubsonicClient } from "./client";

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
  const creditsUrl = new URL("credits.html", catalogBase).href;
  let runtime = $state.raw<{ network: Network; auth: AuthStore }>();
  let error = $state("");
  let controller: AbortController | undefined;

  async function start() {
    controller?.abort();
    const attempt = new AbortController();
    controller = attempt;
    error = "";
    try {
      const catalog = await loadCatalog(catalogBase, attempt.signal);
      attempt.signal.throwIfAborted();
      const auth = new AuthStore(new MemoryStorage());
      // Public synthetic identity, not a server credential. Its URL isolates the OPFS account.
      auth.save({
        host: base.href.replace(/\/$/, ""),
        username: "static-demo",
        token: "local-demo",
        salt: "local-demo",
      });
      const network = new Network((identity) => {
        // Shared Settings remains unchanged, but this entry cannot switch to a real account.
        if (identity.host !== base.href.replace(/\/$/, "") || identity.username !== "static-demo") {
          throw new Error("This demo is fixed to its local library. Reload the demo to reconnect.");
        }
        return new StaticSubsonicClient(identity, catalog);
      });
      runtime = { network, auth };
    } catch (cause) {
      if (!attempt.signal.aborted)
        error = cause instanceof Error ? cause.message : "Could not load the demo.";
    }
  }

  onMount(() => {
    void start();
    return () => controller?.abort();
  });
</script>

{#if runtime}
  <aside class="view container row-sm" aria-label="Demo information">
    <span class="type-small text-muted">Demo library · online launch required</span>
    <a class="text-link type-small" href={creditsUrl} target="_blank" rel="noopener">Demo credits</a
    >
  </aside>
  <App network={runtime.network} auth={runtime.auth} updaterComponent={undefined} />
{:else}
  <main class="view container stack-md">
    <h1 class="type-heading">Libras demo</h1>
    {#if error}
      <p role="alert">{error}</p>
      <button class="button" data-size="md" onclick={() => void start()}>Retry</button>
    {:else}
      <p role="status">Loading demo library…</p>
    {/if}
  </main>
{/if}
