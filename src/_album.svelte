<script lang="ts">
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./artwork.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Track } from "./schema";
  import type { Playback } from "./playback.svelte";
  import type { RouteParams } from "./router.svelte";
  import type { Session } from "./session.svelte";

  interface Props {
    params: RouteParams;
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playbackState: "loading" | "playing" | "paused";
    playback: Playback;
  }

  let { params, cache, covers, trackEngine, session, playbackState, playback }: Props = $props();

  const offlineMode = $derived(session.offlineMode);
  const loading = $derived(!session.localReady);
  const libraryAvailable = $derived(cache.savedAt !== undefined);
  const currentTrack = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const artist = $derived(params.artistId ? cache.artists.get(params.artistId) : undefined);
  const album = $derived(params.albumId ? cache.albums.get(params.albumId) : undefined);
  const visibleTracks = $derived(
    album
      ? offlineMode
        ? (cache.albumTracks.get(album.id) ?? []).filter(
            (track) => trackEngine.getStatus(track.id) === "downloaded",
          )
        : (cache.albumTracks.get(album.id) ?? [])
      : [],
  );
  const visibleTrackIds = $derived(visibleTracks.map((track) => track.id));

  function playTrack(track: Immutable<Track>) {
    void playback.replaceQueueAndPlay(visibleTrackIds, visibleTrackIds.indexOf(track.id));
  }
</script>

<section>
  {#if libraryAvailable && artist && album}
    <div class="view collection-view">
      <Artwork
        {covers}
        id={album.artworkId}
        size="stretch"
        loading="eager"
        viewTransitionName={`album-cover-${album.id}`}
      />
      <div class="section-heading collection-heading">
        <div>
          <a
            class="text-link type-eyebrow text-muted"
            href={`#/library/artist/${encodeURIComponent(artist.id)}`}
          >
            {artist.name}
          </a>
          <h2
            class="type-heading"
            style:view-transition-name={CSS.escape(`album-name-${album.id}`)}
          >
            {album.title}
          </h2>
          <p class="library-meta type-small">
            {album.year ?? "Unknown year"} · {visibleTracks.length}
            track{visibleTracks.length === 1 ? "" : "s"}
          </p>
          {#if album.genres.length > 0}
            <div class="genre-list">
              {#each album.genres as genre}
                <span class="type-caption">
                  {genre}
                </span>
              {/each}
            </div>
          {/if}
        </div>
        <button
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          commandfor="album-page-menu"
          command="show-modal"
          title={`Open menu for ${album.title}`}
        >
          <svg aria-hidden="true" width="20" height="20"><use href="#icon-menu"></use></svg>
        </button>
      </div>

      {#if loading}
        <div class="empty-state">
          <div class="scan-spinner">
            <svg aria-hidden="true" width="20" height="20"><use href="#icon-loading"></use></svg>
          </div>
          <p class="type-body">Restoring local library…</p>
        </div>
      {/if}
    </div>
    <div class="wings">
      {#each visibleTracks as track, index}
        {@const trackMenuId = `album-track-menu-${index}`}
        {@const downloadStatus = trackEngine.getStatus(track.id)}
        <div class="wings-item row-button">
          <button
            class="linkarea"
            aria-label={`Play ${track.title}`}
            onclick={() => playTrack(track)}
            data-longpressfor={trackMenuId}
            data-longpress="show-modal"
            title={`${track.title} — hold for actions`}
          ></button>
          <span class="track-leading">
            {#if currentTrack?.id === track.id && playbackState === "loading"}
              <span role="img" aria-label="Loading playback">
                <svg aria-hidden="true" width="20" height="20"><use href="#icon-loading"></use></svg
                >
              </span>
            {:else if currentTrack?.id === track.id && playbackState === "playing"}
              <span role="img" aria-label="Playing">
                <svg aria-hidden="true" width="20" height="20"
                  ><use href="#icon-sound-bars"></use></svg
                >
              </span>
            {:else if currentTrack?.id === track.id}
              <span role="img" aria-label="Current track, not playing">
                <svg aria-hidden="true" width="20" height="20"><use href="#icon-pause"></use></svg>
              </span>
            {:else if downloadStatus === "downloading"}
              <span role="img" aria-label="Downloading">
                <svg aria-hidden="true" width="20" height="20"><use href="#icon-loading"></use></svg
                >
              </span>
            {:else if downloadStatus === "queued"}
              <span role="img" aria-label="Queued for download">
                <svg aria-hidden="true" width="20" height="20"><use href="#icon-clock"></use></svg>
              </span>
            {:else}
              {track.number ?? index + 1}
            {/if}
          </span>
          <span>{track.title}</span>
          <button
            class="icon-button"
            data-size="sm"
            data-variant="ghost"
            commandfor={trackMenuId}
            command="show-modal"
            title={`Open menu for ${track.title}`}
          >
            <svg aria-hidden="true" width="20" height="20"><use href="#icon-menu"></use></svg>
          </button>
        </div>
      {:else}
        {#if !loading}
          <div class="empty-state">
            <p class="type-body">
              {offlineMode ? "No downloaded tracks." : "No tracks found."}
            </p>
          </div>
        {/if}
      {/each}
    </div>
  {:else if !loading}
    <div class="empty-state">
      <span
        ><svg aria-hidden="true" width="20" height="20"><use href="#icon-music"></use></svg></span
      >
      <p class="type-body">
        {libraryAvailable ? "Album not found." : "Connect your library."}
      </p>
      <a
        class="button"
        data-size="md"
        data-variant="neutral"
        href={libraryAvailable ? "#/library" : "#/settings"}
      >
        {libraryAvailable ? "Open library" : "Open settings"}
      </a>
    </div>
  {/if}
</section>

{#if libraryAvailable && artist && album}
  <dialog
    id="album-page-menu"
    class="action-menu"
    aria-labelledby="album-page-menu-title"
    closedby="closerequest"
    data-swipedown="close"
    onclick={(event) => event.currentTarget.close()}
  >
    <div class="wings">
      <header class="topbar wings-item">
        <button class="icon-button" data-size="sm" data-variant="ghost" title="Close menu">
          <svg class="self-center" aria-hidden="true" width="20" height="20"
            ><use href="#icon-chevron-down"></use></svg
          >
        </button>
        <span id="album-page-menu-title" class="type-title">{album.title}</span>
      </header>
      <button
        class="wings-item row-button"
        onclick={() => void playback.replaceQueueAndPlay(visibleTrackIds)}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-play"></use></svg
        >
        <span>Play</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => void playback.enqueue(visibleTrackIds, "next")}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-next"></use></svg
        >
        <span>Play next</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => void playback.enqueue(visibleTrackIds, "last")}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-plus"></use></svg
        >
        <span>Play last</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() =>
          (cache.albumTracks.get(album.id) ?? []).forEach(
            (track) => void trackEngine.download(track.id),
          )}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-download"></use></svg
        >
        <span>Download</span>
      </button>
    </div>
  </dialog>
  {#each visibleTracks as track, index}
    {@const trackMenuId = `album-track-menu-${index}`}
    {@const downloadStatus = trackEngine.getStatus(track.id)}
    <dialog
      id={trackMenuId}
      class="action-menu"
      aria-labelledby={`${trackMenuId}-title`}
      closedby="closerequest"
      data-swipedown="close"
      onclick={(event) => event.currentTarget.close()}
    >
      <div class="wings">
        <header class="topbar wings-item">
          <button class="icon-button" data-size="sm" data-variant="ghost" title="Close menu">
            <svg class="self-center" aria-hidden="true" width="20" height="20"
              ><use href="#icon-chevron-down"></use></svg
            >
          </button>
          <span id={`${trackMenuId}-title`} class="type-title">{track.title}</span>
        </header>
        <button class="wings-item row-button" onclick={() => playTrack(track)}>
          <svg class="self-center" aria-hidden="true" width="20" height="20"
            ><use href="#icon-play"></use></svg
          >
          <span>Play</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => void playback.enqueue([track.id], "next")}
        >
          <svg class="self-center" aria-hidden="true" width="20" height="20"
            ><use href="#icon-next"></use></svg
          >
          <span>Play next</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => void playback.enqueue([track.id], "last")}
        >
          <svg class="self-center" aria-hidden="true" width="20" height="20"
            ><use href="#icon-plus"></use></svg
          >
          <span>Play last</span>
        </button>
        <button
          class="wings-item row-button"
          disabled={downloadStatus !== "idle"}
          onclick={() => void trackEngine.download(track.id)}
        >
          {#if downloadStatus === "downloaded"}
            <svg class="self-center" aria-hidden="true" width="20" height="20"
              ><use href="#icon-check"></use></svg
            >
            <span>Downloaded</span>
          {:else if downloadStatus === "queued"}
            <svg class="self-center" aria-hidden="true" width="20" height="20"
              ><use href="#icon-clock"></use></svg
            >
            <span>Queued</span>
          {:else if downloadStatus === "downloading"}
            <svg class="self-center" aria-hidden="true" width="20" height="20"
              ><use href="#icon-loading"></use></svg
            >
            <span>Downloading…</span>
          {:else}
            <svg class="self-center" aria-hidden="true" width="20" height="20"
              ><use href="#icon-download"></use></svg
            >
            <span>Download</span>
          {/if}
        </button>
      </div>
    </dialog>
  {/each}
{/if}
