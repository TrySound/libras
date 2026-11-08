<script lang="ts">
  import { onDestroy } from "svelte";
  import App from "./app.svelte";
  import InstallCard from "./install-card.svelte";
  import WebappUpdater from "./webapp-updater.svelte";
  import { Network } from "./network.svelte";
  import { AuthStore } from "./auth";
  import type { InstallController } from "./install.svelte";

  let { installation }: { installation: InstallController } = $props();
  const network = new Network();
  const auth = new AuthStore();
  onDestroy(() => installation.destroy());
</script>

<App {network} {auth} updaterComponent={WebappUpdater}>
  {#snippet settingsContent()}
    <InstallCard {installation} />
  {/snippet}
</App>
