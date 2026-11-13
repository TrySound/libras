<script lang="ts">
  import type { Session } from "../session.svelte";
  let { session }: { session: Session } = $props();
  const id = $props.id();
</script>

<fieldset class="stack-sm">
  <legend class="label">Library scope</legend>
  <div class="row-md row-wrap">
    {#each [["all", "All music"], ["downloaded", "Downloaded"]] as [value, label]}
      <label class="row-sm" for={`${id}-${value}`}>
        <input
          id={`${id}-${value}`}
          type="radio"
          name={id}
          checked={session.downloadedOnly === (value === "downloaded")}
          onchange={() => session.setDownloadedOnly(value === "downloaded")}
        />
        {label}
      </label>
    {/each}
  </div>
  {#if session.downloadedOnly}
    <button
      class="button"
      data-size="text"
      data-variant="secondary"
      onclick={() => session.setDownloadedOnly(false)}>Show all music</button
    >
  {/if}
</fieldset>

<style>
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-inline-size: 0;
  }
</style>
