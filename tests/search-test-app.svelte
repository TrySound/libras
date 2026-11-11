<script lang="ts">
  import { untrack } from "svelte";
  import Search from "../src/_search.svelte";
  import { route } from "../src/router.svelte";
  import { installNavigation } from "./router-test-helpers";

  let { props }: { props: import("svelte").ComponentProps<typeof Search> } = $props();
  let visible = $state(true);
  untrack(() => {
    route.parameters = new URLSearchParams("/search");
    installNavigation("/search", (path) => {
      window.history.replaceState(null, "", `?${path}`);
      route.parameters = new URL(window.location.href).searchParams;
    });
  });
</script>

<button onclick={() => (visible = !visible)}>Toggle route</button>
{#if visible}<Search {...props} />{/if}
