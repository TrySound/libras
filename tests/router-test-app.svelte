<script lang="ts">
  import Router, { type RouteControls, type RouteParams } from "../src/router.svelte";

  let { capture }: { capture: (controls: RouteControls) => void } = $props();
</script>

{#snippet page(name: string, params: RouteParams, controls: RouteControls)}
  <p>{name}:{JSON.stringify(params)}</p>
  <button onclick={() => capture(controls)}>Controls</button>
{/snippet}
{#snippet library(params: RouteParams, controls: RouteControls)}
  {@render page("library", params, controls)}
{/snippet}
{#snippet artist(params: RouteParams, controls: RouteControls)}
  {@render page("artist", params, controls)}
{/snippet}
{#snippet album(params: RouteParams, controls: RouteControls)}
  {@render page("album", params, controls)}
{/snippet}
{#snippet player(params: RouteParams, controls: RouteControls)}
  {@render page("player", params, controls)}
{/snippet}

<Router
  routes={[
    { pattern: "/library/artist/:artistId/album/:albumId", render: album },
    { pattern: "/library/artist/:artistId", render: artist },
    { pattern: "/library", render: library },
    { pattern: "/player", render: player },
  ]}
  fallback={{ pattern: "/library", render: library }}
/>
