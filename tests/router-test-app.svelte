<script lang="ts">
  import Router, { Route, type RouteParams } from "../src/router.svelte";

  let { embedded = false, route = new Route() }: { embedded?: boolean; route?: Route } = $props();
</script>

{#snippet page(name: string, params: RouteParams)}
  <p>{name}:{JSON.stringify(params)}</p>
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

<section data-route-pattern={route.pattern} data-route-url={route.url?.href}>
  <input aria-label="Persistent shell input" />
</section>
<Router
  {embedded}
  {route}
  routes={[
    { pattern: "/library/artist/:artistId/album/:albumId", render: album },
    { pattern: "/library/artist/:artistId", render: artist },
    { pattern: "/library", render: library },
    { pattern: "/player", render: player },
  ]}
  fallback={{ pattern: "/library", render: library }}
/>
