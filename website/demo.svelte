<script lang="ts">
  import { onMount } from "svelte";
  import App from "../src/app.svelte";
  import { AuthStore } from "../src/auth";
  import { Network } from "../src/network.svelte";
  import type { Session } from "../src/session.svelte";
  import { loadCatalog } from "./catalog";
  import { StaticSubsonicClient } from "./client";
  import { NamespacedStorage } from "./storage";
  import Settings from "./settings.svelte";

  const base = new URL(import.meta.env.BASE_URL, location.origin);
  const catalogBase = new URL("catalog/", base);
  const creditsUrl = new URL("credits.html", catalogBase).href;
  let runtime = $state.raw<{ network: Network; auth: AuthStore; preferences: Storage }>();
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
      const preferences = new NamespacedStorage(localStorage, `libras-demo:${base.pathname}:`);
      const auth = new AuthStore(preferences);
      // Public synthetic identity, not a server credential. Its URL isolates the OPFS account.
      auth.save({
        host: base.href.replace(/\/$/, ""),
        username: "static-demo",
        token: "local-demo",
        salt: "local-demo",
      });
      const network = new Network(
        (identity) => new StaticSubsonicClient(identity, catalog, preferences),
      );
      runtime = { network, auth, preferences };
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

{#snippet settingsView(session: Session)}
  <Settings {session} {creditsUrl} />
{/snippet}

{#snippet headerContent()}
  <a class="text-link type-small" href={creditsUrl} target="_blank" rel="noopener">Demo credits</a>
{/snippet}

{#if runtime}
  <App {...runtime} {settingsView} {headerContent} title="Libras demo" />
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
