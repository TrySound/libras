<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./artwork.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Artist } from "./schema";
  import type { Playback } from "./playback.svelte";
  import type { Session } from "./session.svelte";
  import type { Playlists } from "./playlists.svelte";
  import { navigate } from "./router.svelte";
  import PlaylistPicker from "./playlist-picker.svelte";
  import { onVisible } from "./viewport";

  interface Props {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playback: Playback;
    playlists: Playlists;
  }

  let { cache, covers, trackEngine, session, playback, playlists }: Props = $props();
  let picker: PlaylistPicker;
  let createError = $state("");
  let creating = $state(false);
  async function createPlaylist() {
    if (creating || session.offlineMode) return;
    creating = true;
    createError = "";
    try {
      const playlist = await playlists.create();
      navigate(`/library/playlist/${encodeURIComponent(playlist.id)}`);
    } catch (error) {
      createError = error instanceof Error ? error.message : "Could not create playlist.";
    } finally {
      creating = false;
    }
  }

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

<section class="view library-view stack-md">
  {#if cache.key && (session.localReady || cache.playlists.summaries.length)}
    <div class="row-md">
      <h2 class="type-heading grow">Playlists</h2>
      <button
        class="icon-button"
        data-size="md"
        data-variant="neutral"
        aria-label="Create playlist"
        title="Create playlist"
        disabled={offlineMode || creating}
        onclick={() => void createPlaylist()}
      >
        <Icon name={creating ? "loading" : "plus"} />
      </button>
    </div>
    {#if createError}<p class="type-small text-danger" role="alert">{createError}</p>{/if}
    {#if cache.playlists.summaries.length}
      <div class="tiles-grid">
        {#each cache.playlists.summaries as playlist (playlist.id)}
          <a
            class="tile"
            href={`#/library/playlist/${encodeURIComponent(playlist.id)}`}
            aria-label={playlist.name}
          >
            <Artwork {covers} id={playlist.artworkId} size="stretch" />
            <strong class="tile-name type-small truncate">{playlist.name}</strong>
          </a>
        {/each}
      </div>
    {:else}
      <p class="type-small text-muted">
        {cache.playlists.listedAt === null ? "Playlists not synced yet." : "No playlists yet."}
      </p>
    {/if}
  {/if}
  {#if libraryAvailable}
    <div class="row-md">
      <div class="stack-xs grow">
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
        <Icon name="search" />
      </a>
    </div>

    {#if loading}
      <div class="empty-state stack-md">
        <div class="scan-spinner">
          <Icon name="loading" />
        </div>
        <p class="type-body text-muted">Restoring local library…</p>
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
            <Artwork {covers} id={artist.artworkId} size="stretch" />
            <strong class="tile-name type-small truncate">
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
      <div class="empty-state stack-md">
        <Artwork {covers} />
        <p class="type-body text-muted">
          {offlineMode ? "No downloaded artists." : "No artists found."}
        </p>
      </div>
    {/if}
  {:else if !loading}
    <div class="empty-state stack-md">
      <Artwork {covers} />
      <h2 class="type-heading">Connect your library</h2>
      <p class="type-body text-muted">Add your music server to start listening.</p>
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
        <Icon name="chevron-down" class="self-center" />
      </button>
      <span id="artist-menu-title" class="type-title">{menuArtist?.name}</span>
    </header>
    <button
      class="wings-item row-button"
      onclick={() => void playback.replaceQueueAndPlay(availableTrackIds)}
    >
      <Icon name="play" class="self-center" />
      <span>Play</span>
    </button>
    <button
      class="wings-item row-button"
      onclick={() => void playback.enqueue(availableTrackIds, "next")}
    >
      <Icon name="next" class="self-center" />
      <span>Play next</span>
    </button>
    <button
      class="wings-item row-button"
      onclick={() => void playback.enqueue(availableTrackIds, "last")}
    >
      <Icon name="plus" class="self-center" />
      <span>Play last</span>
    </button>
    <button
      class="wings-item row-button"
      disabled={offlineMode || !tracks.length}
      onclick={() => picker.open(tracks.map((track) => track.id))}
    >
      <Icon name="plus" class="self-center" /><span>Add to playlist</span>
    </button>
    <button
      class="wings-item row-button"
      onclick={() => trackEngine.downloadMany(tracks.map((track) => track.id))}
    >
      <Icon name="download" class="self-center" />
      <span>Download</span>
    </button>
  </div>
</dialog>
<PlaylistPicker bind:this={picker} {cache} {playlists} {session} />
