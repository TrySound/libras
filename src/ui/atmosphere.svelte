<script lang="ts">
  let { src }: { src?: string } = $props();
</script>

<div class="atmosphere-frame" aria-hidden="true">
  <img class="atmosphere" {src} hidden={!src} alt="" aria-hidden="true" draggable="false" />
  <div class="atmosphere-lines"></div>
</div>
