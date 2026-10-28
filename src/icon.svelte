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
    | "sound-bars"
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
  <use href={`#icon-${name}`}></use>
</svg>
