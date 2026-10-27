<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Covers } from "../covers.svelte";
  import Artwork from "./artwork.svelte";
  let { covers, artworkId, title, credit, href, metadata, actions } = $props<{
    covers: Covers;
    artworkId?: string;
    title: string;
    credit?: string;
    href?: string;
    metadata: string;
    actions: Snippet;
  }>();
</script>

<div class="viewport-panel">
  <Artwork {covers} id={artworkId} size="cover" loading="eager" class="viewport-panel-cover" />
  <div class="stack-sm">
    <div class="row-md row-justify">
      <div class="stack-xs">
        <h1 class="heading-xl">{title}</h1>
        {#if credit}<a class="button-quiet caption text-secondary" {href}>{credit}</a>{/if}
      </div>
      <div class="row-sm">{@render actions()}</div>
    </div>
    <p class="caption text-secondary">{metadata}</p>
  </div>
</div>
