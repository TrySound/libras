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
    size?: number;
    class?: string;
    color?: string;
  }

  let { name, size = 24, class: className, color }: Props = $props();
</script>

<svg class={className} {color} aria-hidden="true" width={size} height={size}>
  <use href={`#icon-${name}`}></use>
</svg>
