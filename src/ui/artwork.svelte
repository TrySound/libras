<script lang="ts">
  import Icon from "../icon.svelte";
  import type { Covers } from "../covers.svelte";
  import { onVisible } from "../viewport";

  interface Props {
    covers: Covers;
    id?: string;
    size?: "sm" | "md" | "lg" | "cover" | "fill";
    loading?: "lazy" | "eager";
    class?: string;
  }

  let { covers, id, size = "md", loading = "lazy", class: className }: Props = $props();
  const cover = $derived(id === undefined ? undefined : covers.ensureCover(id));

  function acquire(node: Element) {
    if (!cover) return;
    if (loading === "eager") {
      cover.load();
      return;
    }
    return onVisible(cover.load)(node);
  }
</script>

<span class={["artwork", className]} data-size={size} aria-hidden="true" {@attach acquire}>
  <img src={cover?.source} hidden={!cover?.source} alt="" />
  <Icon name="music" size={size === "cover" ? 96 : 20} class="artwork-placeholder" />
</span>
