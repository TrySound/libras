<script module lang="ts">
  export type IconName =
    | "brand"
    | "search"
    | "back"
    | "check"
    | "chevron-down"
    | "clock"
    | "download"
    | "refresh"
    | "disconnect"
    | "home"
    | "loading"
    | "menu"
    | "music"
    | "next"
    | "pause"
    | "play"
    | "plus"
    | "previous"
    | "sound-bars"
    | "cross"
    | "error"
    | "idle"
    | "offline"
    | "settings";
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: "md" | "lg" | "xl" | number;
    class?: string;
    color?: string;
  }

  const sizes = { md: 20, lg: 32, xl: 64 };

  let { name, size = "md", class: className, color }: Props = $props();
  const pixels = $derived(typeof size === "number" ? size : sizes[size]);
</script>

<svg class={className} {color} aria-hidden="true" width={pixels} height={pixels}>
  <use href={`#icon-${name}`}></use>
</svg>
