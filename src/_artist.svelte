<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
  import Atmosphere from "./ui/atmosphere.svelte";
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
    playback: Playback;
  }

  let { params, cache, covers, trackEngine, session, playback }: Props = $props();

  const loading = $derived(!session.localReady);
  const offlineMode = $derived(session.offlineMode);
  const libraryAvailable = $derived(cache.savedAt !== undefined);
  const artist = $derived(params.artistId ? cache.artists.get(params.artistId) : undefined);
  const atmosphere = $derived(artist?.artworkId ? covers.ensureCover(artist.artworkId) : undefined);
  const albums = $derived(artist ? (cache.artistAlbums.get(artist.id) ?? []) : []);
  const tracks = $derived(albums.flatMap((album) => cache.albumTracks.get(album.id) ?? []));
  const visibleAlbums = $derived(
    offlineMode
      ? albums.filter((album) =>
          (cache.albumTracks.get(album.id) ?? []).some(
            (track) => trackEngine.getStatus(track.id) === "downloaded",
          ),
        )
      : albums,
  );
  const genres = $derived([...new Set(albums.flatMap((album) => album.genres))]);

  function availableTrackIds(items: readonly Immutable<Track>[]) {
    return items
      .filter((track) => !offlineMode || trackEngine.getStatus(track.id) === "downloaded")
      .map((track) => track.id);
  }

  let menuAlbumId = $state<string>();
  const menuAlbum = $derived(menuAlbumId ? cache.albums.get(menuAlbumId) : undefined);
  const menuTracks = $derived(menuAlbum ? (cache.albumTracks.get(menuAlbum.id) ?? []) : tracks);
  const menuTitle = $derived(menuAlbum?.title ?? artist?.name);
  const menuArtwork = $derived(menuAlbum ? menuAlbum.artworkId : artist?.artworkId);
  const menuTrackIds = $derived(availableTrackIds(menuTracks));

  let sheet: HTMLDialogElement;
  let popover: HTMLDivElement;
  function dismissActions() {
    sheet.close();
    popover.hidePopover?.();
  }
</script>

<Atmosphere src={libraryAvailable && artist ? atmosphere?.source : undefined} />
<section class="split-layout" aria-label="Artist details">
  {#if libraryAvailable && artist}
    <div class="viewport-panel view-slide-up">
      <Artwork
        {covers}
        id={artist.artworkId}
        size="cover"
        loading="eager"
        class="viewport-panel-cover"
        transitionName="artist-artwork"
      />
      <div class="stack-sm">
        <div class="row-md row-justify">
          <div class="stack-xs"><h1 class="heading-xl">{artist.name}</h1></div>
          <div class="row-sm">
            <button
              class="button"
              data-variant="primary"
              aria-label={`Play ${artist.name}`}
              disabled={!availableTrackIds(tracks).length}
              onclick={() => void playback.replaceQueueAndPlay(availableTrackIds(tracks))}
            >
              <Icon name="play" />
            </button>
            <button
              class="button only-mobile"
              data-variant="secondary"
              commandfor="artist-detail-menu"
              command="show-modal"
              aria-label={`Actions for ${artist.name}`}
              onclick={() => (menuAlbumId = undefined)}
            >
              <Icon name="menu" />
            </button>
            <button
              class="button only-desktop"
              data-variant="secondary"
              commandfor="artist-detail-menu-popover"
              command="toggle-popover"
              aria-label={`Actions for ${artist.name}`}
              onclick={() => (menuAlbumId = undefined)}
            >
              <Icon name="menu" />
            </button>
          </div>
        </div>
        <p class="caption text-subtle">
          {visibleAlbums.length} album{visibleAlbums.length === 1 ? "" : "s"}
        </p>
        {#if genres.length}
          <p class="caption text-secondary" role="group" aria-label="Genres">
            {genres.join(" · ")}
          </p>
        {/if}
      </div>
    </div>
    <div class="stack-lg scroll-runway view-slide-left">
      <h2 class="heading-lg uppercase">{offlineMode ? "Downloaded albums" : "Albums"}</h2>
      <div class="stack-sm">
        {#each visibleAlbums as album (album.id)}
          {@const ids = availableTrackIds(cache.albumTracks.get(album.id) ?? [])}
          <article class="menu-item track-row">
            <div class="row-sm">
              <Artwork {covers} id={album.artworkId} size="sm" />
              <div>
                <p class="label">{album.title}</p>
                <p class="caption text-subtle">
                  {album.year ?? "Unknown year"} · {ids.length} track{ids.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <a
              class="link-target"
              href={`#/library/artist/${encodeURIComponent(artist.id)}/album/${encodeURIComponent(album.id)}`}
              aria-label={`Open ${album.title}`}
              data-longpressfor="artist-detail-menu"
              data-longpress="show-modal"
              onfocus={() => (menuAlbumId = album.id)}
            ></a>
            <div class="row-sm">
              <button
                class="button only-mobile"
                data-variant="secondary"
                commandfor="artist-detail-menu"
                command="show-modal"
                aria-label={`Actions for ${album.title}`}
                onclick={() => (menuAlbumId = album.id)}
              >
                <Icon name="menu" />
              </button>
              <button
                class="button only-desktop"
                data-variant="secondary"
                commandfor="artist-detail-menu-popover"
                command="toggle-popover"
                aria-label={`Actions for ${album.title}`}
                onclick={() => (menuAlbumId = album.id)}
              >
                <Icon name="menu" />
              </button>
            </div>
          </article>
        {:else}
          {#if !loading}<p class="body">
              {offlineMode ? "No downloaded albums." : "No albums found."}
            </p>{/if}
        {/each}
      </div>
    </div>
  {:else if !loading}
    <div class="stack-md scroll-runway">
      <h1 class="heading-sm">{libraryAvailable ? "Artist not found." : "Connect your library."}</h1>
      <div class="row-sm">
        <a
          class="button"
          data-size="text"
          data-variant="secondary"
          href={libraryAvailable ? "#/library" : "#/settings"}
        >
          {libraryAvailable ? "Open library" : "Open settings"}</a
        >
      </div>
    </div>
  {/if}
</section>

<dialog
  bind:this={sheet}
  id="artist-detail-menu"
  class="bottom-sheet"
  aria-labelledby="artist-detail-menu-title"
  closedby="any"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render actions("artist-detail-menu", false)}
</dialog>
<div
  bind:this={popover}
  id="artist-detail-menu-popover"
  class="popover"
  popover="auto"
  role="dialog"
  aria-labelledby="artist-detail-menu-popover-title"
>
  {@render actions("artist-detail-menu-popover", true)}
</div>

{#snippet actions(target: string, isPopover: boolean)}
  <div class="stack-lg">
    <header class="row-md row-justify">
      <div class="row-md">
        <Artwork {covers} id={menuArtwork} size="lg" />
        <h2 id={`${target}-title`} class="heading-md">{menuTitle}</h2>
      </div>
      <button
        class="button"
        commandfor={target}
        command={isPopover ? "hide-popover" : "close"}
        aria-label="Close menu"
      >
        <Icon name="cross" />
      </button>
    </header>
    <div class="stack-sm">
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.replaceQueueAndPlay(menuTrackIds);
          dismissActions();
        }}
      >
        <Icon name="play" />
        <span>Play</span>
      </button>
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.enqueue(menuTrackIds, "next");
          dismissActions();
        }}
      >
        <Icon name="next" />
        <span>Play next</span>
      </button>
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.enqueue(menuTrackIds, "last");
          dismissActions();
        }}
      >
        <Icon name="plus" />
        <span>Play last</span>
      </button>
      <button
        class="menu-item"
        disabled={!menuTracks.length}
        onclick={() => {
          trackEngine.downloadMany(menuTracks.map((track) => track.id));
          dismissActions();
        }}
      >
        <Icon name="download" />
        <span>Download</span>
      </button>
    </div>
  </div>
{/snippet}
