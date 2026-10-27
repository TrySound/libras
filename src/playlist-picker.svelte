<script lang="ts">
  import type { Cache } from "./cache.svelte";
  import type { Playlists } from "./playlists.svelte";
  import type { Session } from "./session.svelte";

  let { cache, playlists, session }: { cache: Cache; playlists: Playlists; session: Session } =
    $props();
  let dialog: HTMLDialogElement;
  let ids = $state<string[]>([]);
  let busy = $state(false);
  let error = $state("");

  export function open(trackIds: readonly string[]) {
    ids = [...trackIds];
    error = "";
    if (!dialog.open) dialog.showModal();
  }

  async function add(id: string) {
    if (busy || session.offlineMode) return;
    busy = true;
    error = "";
    try {
      const detail = await playlists.open(id);
      await playlists.apply({
        kind: "append",
        id,
        expected: detail.entries.map((item) => item.id),
        ids,
      });
      dialog.close();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Could not add tracks to playlist.";
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="action-menu playlist-picker"
  aria-label="Add to playlist"
  closedby="closerequest"
  data-swipedown="close"
>
  <div class="wings">
    <header class="topbar wings-item">
      <button
        class="icon-button"
        data-size="sm"
        data-variant="ghost"
        aria-label="Close"
        onclick={() => dialog.close()}>×</button
      ><span class="type-title">Add to playlist</span>
    </header>
    {#if session.offlineMode}
      <p class="wings-item type-small text-muted">Connect to edit playlists.</p>
    {:else if !cache.playlists.summaries.length}
      <p class="wings-item type-small text-muted">No playlists yet. Create one in Library.</p>
    {:else}
      {#each cache.playlists.summaries as playlist (playlist.id)}
        <button
          class="wings-item row-button"
          disabled={busy || (!!playlist.owner && playlist.owner !== session.auth?.username)}
          onclick={() => void add(playlist.id)}>{playlist.name}</button
        >
      {/each}
    {/if}
    {#if busy}<p class="wings-item type-small text-muted" role="status">Adding tracks…</p>{/if}
    {#if error}<p class="wings-item type-small text-danger" role="alert">{error}</p>{/if}
  </div>
</dialog>
