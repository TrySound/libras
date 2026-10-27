<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
  import Loader from "./ui/loader.svelte";
  import CollectionTile from "./ui/collection-tile.svelte";
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

  function observeActionBreakpoint(node: HTMLElement) {
    if (typeof ResizeObserver === "undefined") return;
    const app = node.closest(".app-root") ?? node;
    let desktop: boolean | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next =
        entry.contentRect.width >=
        64 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (desktop !== undefined && next !== desktop) dismissActions();
      desktop = next;
    });
    observer.observe(app);
    return () => observer.disconnect();
  }

  function dismissActions() {
    (document.getElementById("artist-menu") as HTMLDialogElement)?.close();
    document.getElementById("artist-popover")?.hidePopover?.();
  }
</script>

<section
  class="ui-edgerunner library-view"
  aria-labelledby="library-heading"
  {@attach observeActionBreakpoint}
>
  <div class="stack-lg scroll-runway">
    <h1 class="visually-hidden" id="library-heading">Your library</h1>
    {#if loading}
      <p class="row-sm label" role="status"><Loader /> Restoring local library…</p>
    {/if}
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
            <CollectionTile
              {covers}
              artworkId={artist.artworkId}
              title={artist.name}
              href={`#/library/artist/${encodeURIComponent(artist.id)}`}
              menuId="artist-menu"
              onselect={() => (menuArtistId = artist.id)}
            >
              {#snippet actions()}
                <button
                  class="button action-mobile"
                  data-variant="secondary"
                  commandfor="artist-menu"
                  command="show-modal"
                  aria-label={`Actions for ${artist.name}`}
                  onclick={() => (menuArtistId = artist.id)}><Icon name="menu" size={24} /></button
                >
                <button
                  class="button action-desktop"
                  data-variant="secondary"
                  commandfor="artist-popover"
                  command="toggle-popover"
                  aria-label={`Actions for ${artist.name}`}
                  onclick={() => (menuArtistId = artist.id)}><Icon name="menu" size={24} /></button
                >
              {/snippet}
            </CollectionTile>
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
  class="ui-edgerunner bottom-sheet action-menu"
  aria-labelledby="artist-menu-title"
  closedby="closerequest"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render artistActions("artist-menu", false)}
</dialog>

<div
  id="artist-popover"
  class="ui-edgerunner popover"
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
        <Icon name="cross" size={24} />
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
        <Icon name="play" size={24} /><span>Play</span>
      </button>
      <button
        class="menu-item"
        disabled={!availableTrackIds.length}
        onclick={() => {
          void playback.enqueue(availableTrackIds, "next");
          dismissActions();
        }}
      >
        <Icon name="next" size={24} /><span>Play next</span>
      </button>
      <button
        class="menu-item"
        disabled={!availableTrackIds.length}
        onclick={() => {
          void playback.enqueue(availableTrackIds, "last");
          dismissActions();
        }}
      >
        <Icon name="plus" size={24} /><span>Play last</span>
      </button>
      <button
        class="menu-item"
        disabled={!tracks.length}
        onclick={() => {
          trackEngine.downloadMany(tracks.map((track) => track.id));
          dismissActions();
        }}
      >
        <Icon name="download" size={24} /><span>Download</span>
      </button>
    </div>
  </div>
{/snippet}
