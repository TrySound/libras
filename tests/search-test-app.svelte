<script lang="ts">
  import Search, { createSearchState } from "../src/_search.svelte";
  let { props }: { props: Omit<import("svelte").ComponentProps<typeof Search>, "state"> } =
    $props();
  let visible = $state(true);
  let searchState = $state(createSearchState());
</script>

<button onclick={() => (visible = !visible)}>Toggle route</button>
{#if visible}<Search {...props} state={searchState} />{/if}
