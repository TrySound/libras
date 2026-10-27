<script lang="ts">
  import type { Snippet } from "svelte";
  import Artwork from "./artwork.svelte";
  import type { Covers } from "../covers.svelte";

  interface Props {
    covers: Covers;
    artworkId?: string;
    title: string;
    href: string;
    menuId: string;
    onselect: () => void;
    actions: Snippet;
  }

  let { covers, artworkId, title, href, menuId, onselect, actions }: Props = $props();
</script>

<article class="tile tile-grid-item">
  <Artwork {covers} id={artworkId} size="fill" class="tile-artwork" />
  <div class="tile-content stack-sm">
    <h3 class="heading-sm">{title}</h3>
  </div>
  <a
    class="link-target"
    {href}
    aria-label={title}
    data-longpressfor={menuId}
    data-longpress="show-modal"
    onfocus={onselect}
  ></a>
  <div class="row-sm tile-actions">
    {@render actions()}
  </div>
</article>
