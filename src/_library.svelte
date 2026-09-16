<script lang="ts">
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./artwork.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Artist } from "./schema";
  import type { Playback } from "./playback.svelte";
  import type { Session } from "./session.svelte";
  import { onVisible } from "./viewport";

  interface Props {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playback: Playback;
  }

  let { cache, covers, trackEngine, session, playback }: Props = $props();

  // The long-press invoker focuses its tile before opening the shared dialog.
  let menuArtistId = $state<string>();
  const menuArtist = $derived(menuArtistId ? cache.artists.get(menuArtistId) : undefined);

  function artistTracks(artist: Immutable<Artist>) {
    return (cache.artistAlbums.get(artist.id) ?? []).flatMap(
      (album) => cache.albumTracks.get(album.id) ?? [],
    );
  }

  const tracks = $derived(menuArtist ? artistTracks(menuArtist) : []);
  const availableTrackIds = $derived(
    tracks
      .filter((track) => !offlineMode || trackEngine.getStatus(track.id) === "downloaded")
      .map((track) => track.id),
  );

  const loading = $derived(!session.localReady);
  const offlineMode = $derived(session.offlineMode);
  const libraryAvailable = $derived(cache.savedAt !== undefined);
  const artists = $derived([...cache.artists.values()]);
  const visibleArtists = $derived(
    offlineMode
      ? artists.filter((artist) =>
          artistTracks(artist).some((track) => trackEngine.getStatus(track.id) === "downloaded"),
        )
      : artists,
  );
  const artistPageSize = 48;
  let artistLimit = $state(artistPageSize);
  const artistPage = $derived(visibleArtists.slice(0, artistLimit));
  function loadMoreArtists() {
    artistLimit = Math.min(artistLimit + artistPageSize, visibleArtists.length);
  }
</script>

<section class="view library-view">
  {#if libraryAvailable}
    <div class="section-heading">
      <div>
        <span class="type-eyebrow text-muted">
          {offlineMode ? "Downloaded music" : "Your music"}
        </span>
        <h2 class="type-heading">{visibleArtists.length} artists</h2>
      </div>
      <a
        class="icon-button"
        data-size="md"
        data-variant="ghost"
        href="#/search"
        aria-label="Search"
        title="Search"
      >
        <svg aria-hidden="true" width="20" height="20"><use href="#icon-search"></use></svg>
      </a>
    </div>

    {#if loading}
      <div class="empty-state">
        <div class="scan-spinner">
          <svg aria-hidden="true" width="20" height="20"><use href="#icon-loading"></use></svg>
        </div>
        <p class="type-body">Restoring local library…</p>
      </div>
    {/if}
    {#if visibleArtists.length > 0}
      <div class="tiles-grid">
        {#each artistPage as artist}
          <a
            class="tile"
            aria-label={artist.name}
            href={`#/library/artist/${encodeURIComponent(artist.id)}`}
            data-longpressfor="artist-menu"
            data-longpress="show-modal"
            onfocus={() => (menuArtistId = artist.id)}
            title={`${artist.name} — hold for actions`}
          >
            <Artwork
              {covers}
              id={artist.artworkId}
              variant="tile"
              viewTransitionName={`artist-cover-${artist.id}`}
            />
            <strong
              class="tile-name type-small"
              style:view-transition-name={CSS.escape(`artist-name-${artist.id}`)}
            >
              {artist.name}
            </strong>
          </a>
        {/each}
      </div>
      {#if artistPage.length < visibleArtists.length}
        {#key artistLimit}
          <!-- Reobserve each batch so a nearby sentinel keeps filling the viewport. -->
          <div aria-hidden="true" style="height: 1px" {@attach onVisible(loadMoreArtists)}></div>
        {/key}
      {/if}
    {:else if !loading}
      <div class="empty-state">
        <span>
          <svg aria-hidden="true" width="20" height="20">
            <use href="#icon-music"></use>
          </svg>
        </span>
        <p class="type-body">
          {offlineMode ? "No downloaded artists." : "No artists found."}
        </p>
      </div>
    {/if}
  {:else if !loading}
    <div class="empty-state">
      <span>
        <svg aria-hidden="true" width="20" height="20">
          <use href="#icon-music"></use>
        </svg>
      </span>
      <h2 class="type-heading">Connect your library</h2>
      <p class="type-body">Add your music server to start listening.</p>
      <a class="button" data-size="md" data-variant="neutral" href="#/settings"> Open settings </a>
    </div>
  {/if}
</section>

<dialog
  id="artist-menu"
  class="action-menu"
  aria-labelledby="artist-menu-title"
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
      <span id="artist-menu-title" class="type-title">{menuArtist?.name}</span>
    </header>
    <button
      class="wings-item row-button"
      onclick={() => void playback.replaceQueueAndPlay(availableTrackIds)}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-play"></use>
      </svg>
      <span>Play</span>
    </button>
    <button
      class="wings-item row-button"
      onclick={() => void playback.enqueue(availableTrackIds, "next")}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-next"></use>
      </svg>
      <span>Play next</span>
    </button>
    <button
      class="wings-item row-button"
      onclick={() => void playback.enqueue(availableTrackIds, "last")}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-plus"></use>
      </svg>
      <span>Play last</span>
    </button>
    <button
      class="wings-item row-button"
      onclick={() => tracks.forEach((track) => void trackEngine.download(track.id))}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-download"></use>
      </svg>
      <span>Download</span>
    </button>
  </div>
</dialog>
