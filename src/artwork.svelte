<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Covers } from "./covers.svelte";
  import { onVisible } from "./viewport";

  interface Props {
    covers: Covers;
    id?: string;
    variant?: "cover" | "tile" | "artwork";
    size?: "sm" | "md";
    loading?: "lazy" | "eager";
    iconSize?: number;
    viewTransitionName?: string;
    children?: Snippet;
  }

  let {
    covers,
    id,
    variant = "cover",
    size = "md",
    loading = "lazy",
    iconSize,
    viewTransitionName,
    children,
  }: Props = $props();
  const cover = $derived(id === undefined ? undefined : covers.ensureCover(id));
  const placeholderSize = $derived(iconSize ?? (variant === "artwork" ? 64 : 20));

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
  class={variant === "tile" ? "tile-image" : variant}
  data-size={variant === "cover" ? size : undefined}
  aria-hidden={children ? undefined : "true"}
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
  {@render children?.()}
</span>
