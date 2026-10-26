<script lang="ts">
  interface Props {
    size?: "lg";
    /** Visual grace period only; never delays the underlying operation. */
    delay?: number;
  }

  let { size, delay = 0 }: Props = $props();
  let ready = $state(false);

  $effect(() => {
    ready = false;
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      ready = true;
    }, delay);
    return () => clearTimeout(timer);
  });
</script>

<!-- Keep the frame stable, but don't mount bars for short operations.
     Consumers provide the visible loading label or accessible control name. -->
<span class="loader" data-size={size} aria-hidden="true">
  {#if delay <= 0 || ready}
    <span class="loader-bar"></span>
    <span class="loader-bar"></span>
    <span class="loader-bar"></span>
    <span class="loader-bar"></span>
    <span class="loader-bar"></span>
  {/if}
</span>
