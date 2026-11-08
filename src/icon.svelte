<script module lang="ts">
  export type IconName =
    | "brand"
    | "search"
    | "check"
    | "clock"
    | "download"
    | "refresh"
    | "home"
    | "loading"
    | "menu"
    | "menu-lines"
    | "disc"
    | "music"
    | "next"
    | "pause"
    | "play"
    | "plus"
    | "previous"
    | "queue"
    | "sound-bars"
    | "sound-bars-static"
    | "cross"
    | "error"
    | "unlink"
    | "offline"
    | "settings";
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: "md" | "lg" | "xl";
    class?: string;
    color?: string;
  }

  let { name, size = "md", class: className, color }: Props = $props();
  const dimension = $derived({ md: 24, lg: 40, xl: 96 }[size]);
</script>

<svg class={className} {color} aria-hidden="true" width={dimension} height={dimension}>
  {#if name === "sound-bars"}
    <use class="sound-bars-animated" href="#icon-sound-bars"></use>
    <use class="sound-bars-static" href="#icon-sound-bars-static"></use>
  {:else}
    <use href={`#icon-${name}`}></use>
  {/if}
</svg>

<style>
  /* SMIL cannot be paused with animation-play-state. Render static geometry instead. */
  .sound-bars-animated {
    display: none;
    @media (prefers-reduced-motion: no-preference) {
      display: inline;
    }
  }
  .sound-bars-static {
    @media (prefers-reduced-motion: no-preference) {
      display: none;
    }
  }
</style>
