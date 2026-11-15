<script lang="ts">
  import type { ComponentProps } from "svelte";
  import Library from "./_search.svelte";
  let props: ComponentProps<typeof Library> = $props();
</script>

<Library {...props} />
