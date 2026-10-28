<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
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

  // Long-press focuses the primary target before opening the shared dialog.
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
  const libraryError = $derived(
    session.refreshError ||
      session.error ||
      (cache.error ? "Some local data could not be restored or saved." : ""),
  );
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

  function dismissActions() {
    (document.getElementById("artist-menu") as HTMLDialogElement)?.close();
    document.getElementById("artist-popover")?.hidePopover?.();
  }
</script>

<section class="library-view" aria-labelledby="library-heading">
  <div class="stack-lg scroll-runway">
    <h1 class="visually-hidden" id="library-heading">Your library</h1>
    {#if libraryError && libraryAvailable}
      <div class="card stack-md">
        <h2 class="heading-sm">Library needs attention</h2>
        <p class="body">
          {libraryError}
        </p>
        <p class="body">Available music is still listed below.</p>
        <div class="row-sm">
          <a class="button" data-variant="secondary" data-size="text" href="#/settings"
            >Open settings</a
          >
        </div>
      </div>
    {/if}
    {#if libraryAvailable}
      <header class="row-md row-justify">
        <h2 class="heading-lg uppercase">{offlineMode ? "Downloaded artists" : "Artists"}</h2>
        <span class="metadata text-subtle">{visibleArtists.length} artists</span>
      </header>
      {#if visibleArtists.length > 0}
        <div class="tile-grid" aria-busy={loading}>
          {#each artistPage as artist (artist.id)}
            <article class="tile tile-grid-item">
              <Artwork {covers} id={artist.artworkId} size="fill" class="tile-artwork" />
              <div class="tile-content stack-sm">
                <h3 class="heading-sm">{artist.name}</h3>
              </div>
              <a
                class="link-target"
                href={`#/library/artist/${encodeURIComponent(artist.id)}`}
                aria-label={artist.name}
                data-longpressfor="artist-menu"
                data-longpress="show-modal"
                onfocus={() => (menuArtistId = artist.id)}
              ></a>
              <div class="row-sm tile-actions">
                <button
                  class="button only-mobile"
                  data-variant="secondary"
                  commandfor="artist-menu"
                  command="show-modal"
                  aria-label={`Actions for ${artist.name}`}
                  onclick={() => (menuArtistId = artist.id)}
                >
                  <Icon name="menu" />
                </button>
                <button
                  class="button only-desktop"
                  data-variant="secondary"
                  commandfor="artist-popover"
                  command="toggle-popover"
                  aria-label={`Actions for ${artist.name}`}
                  onclick={() => (menuArtistId = artist.id)}
                >
                  <Icon name="menu" />
                </button>
              </div>
            </article>
          {/each}
        </div>
        {#if artistPage.length < visibleArtists.length}
          {#key artistLimit}
            <!-- Reobserve each batch so a nearby sentinel keeps filling the viewport. -->
            <div
              class="library-sentinel"
              aria-hidden="true"
              {@attach onVisible(loadMoreArtists)}
            ></div>
          {/key}
        {/if}
      {:else if !loading}
        <div class="stack-md">
          <h3 class="heading-sm">{offlineMode ? "No downloaded artists." : "No artists found."}</h3>
          <p class="body">
            {offlineMode
              ? "Download music from the library to listen offline."
              : "Your server's artists will appear here after synchronization."}
          </p>
        </div>
      {/if}
    {:else if !loading}
      <div class="stack-md">
        <h2 class="heading-sm">{libraryError ? "Library unavailable" : "Connect your library"}</h2>
        <p class="body">{libraryError || "Add your music server to start listening."}</p>
        <div class="row-sm">
          <a class="button" data-size="text" data-variant="secondary" href="#/settings"
            >Open settings</a
          >
        </div>
      </div>
    {/if}
  </div>
</section>

<dialog
  id="artist-menu"
  class="bottom-sheet"
  aria-labelledby="artist-menu-title"
  closedby="any"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render artistActions("artist-menu", false)}
</dialog>

<div
  id="artist-popover"
  class="popover"
  popover="auto"
  role="dialog"
  aria-labelledby="artist-popover-title"
>
  {@render artistActions("artist-popover", true)}
</div>

{#snippet artistActions(id: string, popover: boolean)}
  <div class="stack-lg">
    <header class="row-md row-justify">
      <div class="row-md">
        <Artwork {covers} id={menuArtist?.artworkId} size="lg" />
        <h2 id={`${id}-title`} class="heading-md">{menuArtist?.name}</h2>
      </div>
      <button
        class="button"
        commandfor={id}
        command={popover ? "hide-popover" : "close"}
        aria-label="Close menu"
      >
        <Icon name="cross" />
      </button>
    </header>
    <div class="stack-sm">
      <button
        class="menu-item"
        disabled={!availableTrackIds.length}
        onclick={() => {
          void playback.replaceQueueAndPlay(availableTrackIds);
          dismissActions();
        }}
      >
        <Icon name="play" />
        <span>Play</span>
      </button>
      <button
        class="menu-item"
        disabled={!availableTrackIds.length}
        onclick={() => {
          void playback.enqueue(availableTrackIds, "next");
          dismissActions();
        }}
      >
        <Icon name="next" />
        <span>Play next</span>
      </button>
      <button
        class="menu-item"
        disabled={!availableTrackIds.length}
        onclick={() => {
          void playback.enqueue(availableTrackIds, "last");
          dismissActions();
        }}
      >
        <Icon name="plus" />
        <span>Play last</span>
      </button>
      <button
        class="menu-item"
        disabled={!trackEngine.downloadsAllowed || !tracks.length}
        onclick={() => {
          trackEngine.downloadMany(tracks.map((track) => track.id));
          dismissActions();
        }}
      >
        <Icon name="download" />
        <span>Download</span>
      </button>
    </div>
  </div>
{/snippet}
