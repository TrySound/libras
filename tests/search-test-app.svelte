<script lang="ts">
  import { untrack } from "svelte";
  import Search from "../src/_search.svelte";
  import { installNavigation } from "./router-test-helpers";

  let { props }: { props: import("svelte").ComponentProps<typeof Search> } = $props();
  let visible = $state(true);
  untrack(() => {
    const navigation = installNavigation("/search", (path) => navigation.commit(`?${path}`));
  });
</script>

<button onclick={() => (visible = !visible)}>Toggle route</button>
{#if visible}<Search {...props} />{/if}
