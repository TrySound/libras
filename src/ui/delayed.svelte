<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    when,
    delay = 300,
    children,
    fallback,
  }: { when: boolean; delay?: number; children: Snippet; fallback?: Snippet } = $props();
  let elapsed = $state(false);

  $effect(() => {
    if (!when) return;
    const timer = setTimeout(() => {
      elapsed = true;
    }, delay);
    return () => {
      clearTimeout(timer);
      elapsed = false;
    };
  });
</script>

{#if when && elapsed}
  {@render children()}
{:else}
  {@render fallback?.()}
{/if}
