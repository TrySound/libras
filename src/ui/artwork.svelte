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
    transitionName?: string;
  }

  let {
    covers,
    id,
    size = "md",
    loading = "lazy",
    class: className,
    transitionName,
  }: Props = $props();
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

<span
  class={["artwork", className]}
  style:view-transition-name={transitionName}
  data-size={size}
  aria-hidden="true"
  {@attach acquire}
>
  <img src={cover?.source} hidden={!cover?.source} alt="" />
  <Icon name="music" size={size === "cover" ? "xl" : "md"} class="artwork-placeholder" />
</span>
