<script lang="ts">
  import Router, { route, type RouteParams } from "../src/router.svelte";

  let { onRender }: { onRender?: (name: string) => void } = $props();
</script>

{#snippet page(name: string, params: RouteParams)}
  <p id="page heading" {@attach () => onRender?.(name)}>{name}:{JSON.stringify(params)}</p>
{/snippet}
{#snippet library(params: RouteParams)}
  {@render page("library", params)}
{/snippet}
{#snippet artist(params: RouteParams)}
  {@render page("artist", params)}
{/snippet}
{#snippet album(params: RouteParams)}
  {@render page("album", params)}
{/snippet}
{#snippet player(params: RouteParams)}
  {@render page("player", params)}
{/snippet}

<output data-route-pattern={route.pattern}></output>
<Router
  routes={[
    { pattern: "/library/artist/:artistId/album/:albumId", render: album },
    { pattern: "/library/artist/:artistId", render: artist },
    { pattern: "/library", render: library },
    { pattern: "/player", render: player },
  ]}
  fallback={{ pattern: "/library", render: library }}
/>
