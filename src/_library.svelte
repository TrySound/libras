<script lang="ts">
  import type { Cache, Immutable } from "./cache.svelte";
  import type { CoverEngine } from "./cover.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Artist, Track } from "./schema";
  import type { PlaybackController } from "./playback-controller.svelte";
  import type { Session } from "./session.svelte";
  import { viewportContent } from "./viewport";
  import { swipeToDismiss } from "./swipe-to-dismiss";

  interface Props {
    cache: Cache;
    coverEngine: CoverEngine;
    trackEngine: TrackEngine;
    session: Session;
    playback: PlaybackController;
  }

  let { cache, coverEngine, trackEngine, session, playback }: Props = $props();

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

  function artistTracks(artist: Immutable<Artist>) {
    return (cache.artistAlbums.get(artist.id) ?? []).flatMap(
      (album) => cache.albumTracks.get(album.id) ?? [],
    );
  }

  function availableTrackIds(items: readonly Immutable<Track>[]) {
    return items
      .filter((track) => !offlineMode || trackEngine.getStatus(track.id) === "downloaded")
      .map((track) => track.id);
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
        {#each visibleArtists as artist, index}
          {@const menuId = `artist-menu-${index}`}
          {@const cover = coverEngine.ensureArtistCover(artist.id)}
          <a
            class="tile"
            {@attach viewportContent(cover.load)}
            aria-label={artist.name}
            href={`#/library/artist/${encodeURIComponent(artist.id)}`}
            data-longpressfor={menuId}
            data-longpress="show-modal"
            title={`${artist.name} — hold for actions`}
          >
            <span
              class="tile-image"
              style:view-transition-name={CSS.escape(`artist-cover-${artist.id}`)}
            >
              {#if cover.source}
                <img src={cover.source} alt="" />
              {:else}
                <span>
                  <svg aria-hidden="true" width="20" height="20"><use href="#icon-music"></use></svg
                  >
                </span>
              {/if}
              <strong
                class="tile-name type-small"
                style:view-transition-name={CSS.escape(`artist-name-${artist.id}`)}
                >{artist.name}</strong
              >
            </span>
          </a>
        {/each}
      </div>
    {:else if !loading}
      <div class="empty-state">
        <span
          ><svg aria-hidden="true" width="20" height="20"><use href="#icon-music"></use></svg></span
        >
        <p class="type-body">
          {offlineMode ? "No downloaded artists." : "No artists found."}
        </p>
      </div>
    {/if}
  {:else if !loading}
    <div class="empty-state">
      <span
        ><svg aria-hidden="true" width="20" height="20"><use href="#icon-music"></use></svg></span
      >
      <h2 class="type-heading">Connect your library</h2>
      <p class="type-body">Add your music server to start listening.</p>
      <a class="button" data-size="md" data-variant="neutral" href="#/settings">Open settings</a>
    </div>
  {/if}
</section>

{#if libraryAvailable}
  {#each visibleArtists as artist, index}
    {@const menuId = `artist-menu-${index}`}
    {@const tracks = artistTracks(artist)}
    {@const visibleTrackIds = availableTrackIds(tracks)}
    <dialog
      id={menuId}
      class="action-menu"
      aria-labelledby={`${menuId}-title`}
      closedby="closerequest"
      use:swipeToDismiss
      onclick={(event) => event.currentTarget.close()}
    >
      <div class="stack-sm">
        <header id={`${menuId}-title`} class="type-title">
          {artist.name}
        </header>
        <div class="wings">
          <button
            class="wings-item row-button"
            onclick={() => void playback.replaceQueueAndPlay(visibleTrackIds)}
          >
            <svg aria-hidden="true" width="20" height="20"><use href="#icon-play"></use></svg>
            <span>Play</span>
          </button>
          <button
            class="wings-item row-button"
            onclick={() => void playback.enqueue(visibleTrackIds, "next")}
          >
            <svg aria-hidden="true" width="20" height="20"><use href="#icon-next"></use></svg>
            <span>Play next</span>
          </button>
          <button
            class="wings-item row-button"
            onclick={() => void playback.enqueue(visibleTrackIds, "last")}
          >
            <svg aria-hidden="true" width="20" height="20"><use href="#icon-plus"></use></svg>
            <span>Play last</span>
          </button>
          <button
            class="wings-item row-button"
            onclick={() => tracks.forEach((track) => void trackEngine.download(track.id))}
          >
            <svg aria-hidden="true" width="20" height="20"><use href="#icon-download"></use></svg>
            <span>Download</span>
          </button>
          <button class="wings-item row-button"><span></span>Cancel</button>
        </div>
      </div>
    </dialog>
  {/each}
{/if}
