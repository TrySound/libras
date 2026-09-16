<script lang="ts">
  import type { Covers } from "./covers.svelte";
  import { onVisible } from "./viewport";

  interface Props {
    covers: Covers;
    id?: string;
    size?: "sm" | "md" | "stretch";
    loading?: "lazy" | "eager";
    iconSize?: number;
    viewTransitionName?: string;
  }

  let { covers, id, size = "md", loading = "lazy", iconSize, viewTransitionName }: Props = $props();
  const cover = $derived(id === undefined ? undefined : covers.ensureCover(id));
  const placeholderSize = $derived(iconSize ?? (size === "stretch" ? 64 : 20));

  function acquire(node: Element) {
    if (!cover) return;
    if (loading === "eager") {
      cover.load();
      return;
    }
    return onVisible(cover.load)(node);
  }
</script>

<span
  class="artwork"
  data-size={size}
  aria-hidden="true"
  style:view-transition-name={viewTransitionName ? CSS.escape(viewTransitionName) : undefined}
  {@attach acquire}
>
  {#if cover?.source}
    <img src={cover.source} alt="" />
  {:else}
    <svg aria-hidden="true" width={placeholderSize} height={placeholderSize}
      ><use href="#icon-music"></use></svg
    >
  {/if}
</span>
