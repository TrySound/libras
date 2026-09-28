<script lang="ts">
  import Icon from "./icon.svelte";
  import Artwork from "./artwork.svelte";
  import type { Cache } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import type { Playlists } from "./playlists.svelte";
  import type { PlaylistEditAction } from "./network.svelte";
  import { PlaylistConflictError } from "./playlists.svelte";
  import type { Playback } from "./playback.svelte";
  import type { Session } from "./session.svelte";
  import type { TrackEngine } from "./track.svelte";
  import { navigate, type RouteParams } from "./router.svelte";

  let {
    params,
    cache,
    covers,
    playlists,
    playback,
    session,
    trackEngine,
  }: {
    params: RouteParams;
    cache: Cache;
    covers: Covers;
    playlists: Playlists;
    playback: Playback;
    session: Session;
    trackEngine: TrackEngine;
  } = $props();
  const id = $derived(params.playlistId ?? "");
  const summary = $derived(cache.playlists.summaries.find((item) => item.id === id));
  const detail = $derived(cache.playlists.details.find((item) => item.summary.id === id));
  const playlist = $derived(summary ?? detail?.summary);
  const ids = $derived(detail?.entries.map((item) => item.id) ?? []);
  const editable = $derived(
    !session.offlineMode &&
      !!playlist &&
      (!playlist.owner || playlist.owner === session.auth?.username),
  );
  const canPlay = $derived(
    ids.some(
      (trackId) =>
        cache.tracks.has(trackId) &&
        (!session.offlineMode || trackEngine.getStatus(trackId) === "downloaded"),
    ),
  );
  let name = $state("");
  let error = $state("");
  let fetching = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let conflict = $state<{ expected: string[]; ids: string[] }>();

  $effect(() => {
    const playlistId = id;
    const selectedCache = cache;
    if (!playlistId || session.offlineMode || !session.localReady) return;
    let active = true;
    fetching = true;
    error = "";
    void playlists
      .open(playlistId)
      .catch((reason) => {
        if (active && cache === selectedCache && id === playlistId)
          error = reason instanceof Error ? reason.message : "Could not load playlist.";
      })
      .finally(() => {
        if (active) fetching = false;
      });
    return () => {
      active = false;
    };
  });
  $effect(() => {
    name = playlist?.name ?? "";
  });

  async function save(action: PlaylistEditAction) {
    if (saving) return;
    saving = true;
    error = "";
    try {
      await playlists.apply(action);
      conflict = undefined;
    } catch (reason) {
      if (reason instanceof PlaylistConflictError && action.kind === "replace")
        conflict = { expected: [...action.expected], ids: [...action.ids] };
      error = reason instanceof Error ? reason.message : "Could not save playlist.";
    } finally {
      saving = false;
    }
  }

  function move(index: number, offset: number) {
    const changed = [...ids];
    [changed[index], changed[index + offset]] = [changed[index + offset], changed[index]];
    void save({ kind: "replace", id, expected: ids, ids: changed });
  }
  function play(start = 0) {
    const playable = ids.findIndex(
      (trackId, index) =>
        index >= start &&
        cache.tracks.has(trackId) &&
        (!session.offlineMode || trackEngine.getStatus(trackId) === "downloaded"),
    );
    const index =
      playable >= 0
        ? playable
        : ids.findIndex(
            (trackId) =>
              cache.tracks.has(trackId) &&
              (!session.offlineMode || trackEngine.getStatus(trackId) === "downloaded"),
          );
    if (index >= 0) void playback.replaceQueueAndPlay(ids, index);
  }
  async function reload() {
    if (fetching || session.offlineMode) return;
    fetching = true;
    error = "";
    try {
      await playlists.open(id);
      conflict = undefined;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Could not load playlist.";
    } finally {
      fetching = false;
    }
  }
  async function removePlaylist() {
    if (saving || !detail) return;
    saving = true;
    error = "";
    try {
      await playlists.apply({ kind: "delete", id, expected: ids });
      navigate("/library", "replace");
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Could not delete playlist.";
    } finally {
      saving = false;
      deleting = false;
    }
  }
</script>

<section class="container stack-md">
  {#if playlist}
    <div class="view collection-view stack-md">
      <div class="collection-artwork">
        <Artwork {covers} id={playlist.artworkId} size="stretch" loading="eager" />
      </div>
      <div class="stack-xs">
        <a href="#/library" class="text-link type-eyebrow text-muted">Playlists</a>
        <h1 class="type-heading">{playlist.name}</h1>
        <p class="type-small text-muted">
          {detail ? `${detail.entries.length} tracks` : "Tracks not loaded"}{session.offlineMode
            ? " · Offline"
            : ""}
        </p>
      </div>
      {#if editable && detail}
        <form
          class="row-sm"
          onsubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed && trimmed !== playlist.name)
              void save({ kind: "rename", id, expected: ids, name: trimmed });
          }}
        >
          <label class="stack-xs grow"
            >Rename playlist
            <input
              class="input"
              aria-label="Playlist name"
              bind:value={name}
              required
              maxlength="200"
              disabled={saving}
            />
          </label>
          <button
            class="button"
            data-size="sm"
            type="submit"
            disabled={saving || !name.trim() || name.trim() === playlist.name}>Save</button
          >
        </form>
      {/if}
      <div class="row-wrap-sm">
        <button
          class="button"
          data-size="sm"
          data-variant="neutral"
          disabled={!canPlay}
          onclick={() => play()}>Play</button
        >
        <button
          class="button"
          data-size="sm"
          data-variant="neutral"
          disabled={!canPlay}
          onclick={() => void playback.enqueue(ids, "next")}>Play next</button
        >
        <button
          class="button"
          data-size="sm"
          data-variant="neutral"
          disabled={!canPlay}
          onclick={() => void playback.enqueue(ids, "last")}>Play last</button
        >
        {#if !session.offlineMode}
          <button
            class="button"
            data-size="sm"
            data-variant="neutral"
            disabled={fetching}
            onclick={() => void reload()}
          >
            Refresh playlist
          </button>
        {/if}
      </div>
      {#if editable && detail}
        {#if deleting}
          <div class="row-sm">
            <span>Delete this playlist?</span>
            <button
              class="button"
              data-size="sm"
              disabled={saving}
              onclick={() => void removePlaylist()}>Confirm delete</button
            >
            <button
              class="button"
              data-size="sm"
              data-variant="neutral"
              onclick={() => (deleting = false)}>Cancel</button
            >
          </div>
        {:else}
          <button
            class="button"
            data-size="sm"
            data-variant="neutral"
            disabled={saving}
            onclick={() => (deleting = true)}>Delete playlist</button
          >
        {/if}
      {/if}
      {#if fetching}<p role="status" class="type-small text-muted">Loading playlist…</p>{/if}
      {#if saving}<p role="status" class="type-small text-muted">Saving playlist…</p>{/if}
      {#if error}<p role="alert" class="type-small text-danger">
          {error}{detail ? " Showing cached tracks." : ""}
        </p>{/if}
      {#if conflict}
        <div class="row-sm">
          <button class="button" data-size="sm" onclick={() => void reload()}
            >Reload playlist</button
          >
          <button
            class="button"
            data-size="sm"
            data-variant="neutral"
            onclick={() => {
              if (conflict) void save({ kind: "replace", id, ...conflict, overwrite: true });
            }}>Overwrite remote changes</button
          >
        </div>
      {/if}
      {#if !detail}
        <p class="type-body text-muted">
          {session.offlineMode
            ? "Playlist tracks haven't been loaded on this device. Connect to view them."
            : fetching
              ? ""
              : "Playlist tracks are not available yet."}
        </p>
      {:else if !detail.entries.length}
        <p class="type-body text-muted">This playlist is empty.</p>
      {/if}
    </div>
    {#if detail}
      <div class="wings">
        {#each detail.entries as entry, index (index)}
          {@const track = cache.tracks.get(entry.id)}
          {@const available =
            !!track && (!session.offlineMode || trackEngine.getStatus(entry.id) === "downloaded")}
          <div class="wings-item row-button">
            <Artwork {covers} id={entry.artworkId ?? track?.artworkId} />
            <span class="stack-xs grow"
              ><strong class="type-title">{entry.title}</strong>
              <small class="type-small text-muted"
                >{entry.artist ?? track?.displayArtist ?? "Unknown artist"}{!track
                  ? " · Unavailable"
                  : session.offlineMode && !available
                    ? " · Not downloaded"
                    : ""}</small
              >
            </span>
            <div class="row-sm">
              <button
                class="icon-button"
                data-size="sm"
                data-variant="ghost"
                aria-label={`Play ${entry.title} at position ${index + 1}`}
                disabled={!available}
                onclick={() => play(index)}><Icon name="play" /></button
              >
              {#if editable}
                <button
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  aria-label={`Move ${entry.title} up from position ${index + 1}`}
                  disabled={saving || index === 0}
                  onclick={() => move(index, -1)}>↑</button
                >
                <button
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  aria-label={`Move ${entry.title} down from position ${index + 1}`}
                  disabled={saving || index === ids.length - 1}
                  onclick={() => move(index, 1)}>↓</button
                >
                <button
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  aria-label={`Remove ${entry.title} at position ${index + 1}`}
                  disabled={saving}
                  onclick={() => void save({ kind: "remove", id, expected: ids, indexes: [index] })}
                  ><Icon name="cross" /></button
                >
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else if session.localReady}
    <div class="view empty-state stack-md">
      <p class="type-body text-muted">Playlist not found.</p>
      <a href="#/library" class="button" data-size="sm">Open library</a>
    </div>
  {/if}
</section>
