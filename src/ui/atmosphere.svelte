<script lang="ts">
  let { src }: { src?: string } = $props();
  const id = $props.id();
  const filterId = `${id}-atmosphere-noise`;
</script>

<svg width="0" height="0" aria-hidden="true" class="filter-definitions">
  <defs>
    <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence baseFrequency="0.01 0.4" result="noise" numOctaves="2" />
      <feDisplacementMap
        in="SourceGraphic"
        in2="noise"
        scale="35"
        xChannelSelector="R"
        yChannelSelector="R"
      />
    </filter>
  </defs>
</svg>

<div class="atmosphere-frame" aria-hidden="true">
  <img
    class="atmosphere"
    {src}
    hidden={!src}
    alt=""
    aria-hidden="true"
    draggable="false"
    style:--atmosphere-filter={`url("#${filterId}")`}
  />
  <div class="atmosphere-lines"></div>
</div>

<style>
  .filter-definitions {
    position: absolute;
    pointer-events: none;
  }
</style>
