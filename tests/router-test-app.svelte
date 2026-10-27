<script lang="ts">
  import Router, { type RenderRoute, type RouteParams } from "../src/router.svelte";

  let {
    embedded = false,
    layout = false,
  }: {
    embedded?: boolean;
    layout?: boolean;
  } = $props();
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

{#snippet frame(route: RenderRoute, params: RouteParams)}
  <section data-layout={route.pattern}>
    <input aria-label="Persistent layout input" />
    {@render route.render(params)}
  </section>
{/snippet}

<Router
  {embedded}
  children={layout ? frame : undefined}
  routes={[
    { pattern: "/library/artist/:artistId/album/:albumId", render: album },
    { pattern: "/library/artist/:artistId", render: artist },
    { pattern: "/library", render: library },
    { pattern: "/player", render: player },
  ]}
  fallback={{ pattern: "/library", render: library }}
/>
