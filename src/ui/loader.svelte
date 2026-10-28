<script lang="ts">
  interface Props {
    size?: "md" | "lg" | "xl";
  }

  let { size = "md" }: Props = $props();
</script>

<!-- Consumers provide the visible loading label or accessible control name. -->
<span class="loader" data-size={size} aria-hidden="true">
  <span class="loader-bar"></span>
  <span class="loader-bar"></span>
  <span class="loader-bar"></span>
  <span class="loader-bar"></span>
  <span class="loader-bar"></span>
</span>
