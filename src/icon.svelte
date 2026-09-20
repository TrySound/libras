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
    | "settings";
</script>

<script lang="ts">
  import spriteUrl from "./icon.svg?url&no-inline";

  interface Props {
    name: IconName;
    size?: "md" | "lg" | "xl";
    class?: string;
  }

  const sizes = { md: 20, lg: 32, xl: 64 };

  let { name, size = "md", class: className }: Props = $props();
</script>

<svg class={className} aria-hidden="true" width={sizes[size]} height={sizes[size]}>
  <use href={`${spriteUrl}#${name}`}></use>
</svg>
