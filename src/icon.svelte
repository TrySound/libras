<script module lang="ts">
  export type IconName =
    | "brand"
    | "search"
    | "check"
    | "clock"
    | "download"
    | "refresh"
    | "home"
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
    | "loader"
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
    label?: string;
  }

  let { name, size = "md", class: className, color, label }: Props = $props();
  const dimension = $derived({ md: 24, lg: 40, xl: 96 }[size]);
</script>

<svg
  class={className}
  class:loader-icon={name === "loader"}
  {color}
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
  width={dimension}
  height={dimension}
>
  <use href={`#icon-${name}`}></use>
</svg>
