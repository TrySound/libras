<script lang="ts">
  import type { Cache, Immutable } from "./cache.svelte";
  import { immediateCover, type CoverEngine } from "./cover.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Track } from "./schema";
  import type { PlaybackController } from "./playback-controller.svelte";
  import type { RouteParams } from "./router.svelte";
  import type { Session } from "./session.svelte";
  import { nearViewport } from "./viewport";

  interface Props {
    params: RouteParams;
    cache: Cache;
    coverEngine: CoverEngine;
    trackEngine: TrackEngine;
    session: Session;
    playback: PlaybackController;
  }

  let { params, cache, coverEngine, trackEngine, session, playback }: Props = $props();

  const loading = $derived(!session.localReady);
  const offlineMode = $derived(session.offlineMode);
  const libraryAvailable = $derived(cache.savedAt !== undefined);
  const artist = $derived(params.artistId ? cache.artists.get(params.artistId) : undefined);
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
  const genres = $derived(
    [
      ...new Map(
        [...(artist?.genres ?? []), ...albums.flatMap((album) => album.genres)].map((genre) => [
          genre.toLocaleLowerCase(),
          genre,
        ]),
      ).values(),
    ].sort((a, b) => a.localeCompare(b)),
  );

  function availableTrackIds(items: readonly Immutable<Track>[]) {
    return items
      .filter((track) => !offlineMode || trackEngine.getStatus(track.id) === "downloaded")
      .map((track) => track.id);
  }
</script>

<section class="view collection-view">
  {#if libraryAvailable && artist}
    {@const artwork = coverEngine.ensureArtistCover(artist.id)}
    <div
      class="artwork"
      style:view-transition-name={CSS.escape(`artist-cover-${artist.id}`)}
      aria-hidden="true"
      {@attach immediateCover(artwork)}
    >
      {#if artwork.source}
        <img src={artwork.source} alt="" />
      {:else}
        <svg aria-hidden="true" width="64" height="64"><use href="#icon-music"></use></svg>
      {/if}
    </div>
    <div class="section-heading collection-heading">
      <div>
        <h2
          class="type-heading"
          style:view-transition-name={CSS.escape(`artist-name-${artist.id}`)}
        >
          {artist.name}
        </h2>
        <p class="library-meta type-small">
          {visibleAlbums.length} album{visibleAlbums.length === 1 ? "" : "s"}
        </p>
        {#if genres.length > 0}
          <div class="genre-list">
            {#each genres as genre}
              <span class="type-caption">{genre}</span>
            {/each}
          </div>
        {/if}
      </div>
      <button
        class="icon-button"
        data-size="md"
        data-variant="neutral"
        commandfor="artist-page-menu"
        command="show-modal"
        title={`Open menu for ${artist.name}`}
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
    <div class="wings">
      {#each visibleAlbums as album, index}
        {@const albumMenuId = `album-menu-${index}`}
        {@const visibleTrackIds = availableTrackIds(cache.albumTracks.get(album.id) ?? [])}
        {@const cover = coverEngine.ensureAlbumCover(album.id)}
        <article class="wings-item row-button">
          <a
            class="linkarea"
            {@attach nearViewport((visible) => {
              if (visible) cover.load();
            })}
            href={`#/library/artist/${encodeURIComponent(artist.id)}/album/${encodeURIComponent(album.id)}`}
            aria-label={`Open ${album.title}`}
            data-longpressfor={albumMenuId}
            data-longpress="show-modal"
            title={`${album.title} — hold for actions`}
          ></a>
          <span class="track-leading">
            <span
              class="cover album-cover"
              style:view-transition-name={CSS.escape(`album-cover-${album.id}`)}
            >
              {#if cover.source}
                <img src={cover.source} alt="" />
              {:else}
                <span
                  ><svg aria-hidden="true" width="20" height="20"
                    ><use href="#icon-music"></use></svg
                  ></span
                >
              {/if}
            </span>
          </span>
          <span class="stack-xs">
            <strong
              class="type-title"
              style:view-transition-name={CSS.escape(`album-name-${album.id}`)}
              >{album.title}</strong
            >
            <small class="type-small text-muted">
              {album.year ?? "Unknown year"} · {visibleTrackIds.length} tracks
            </small>
          </span>
          <span class="track-actions">
            <button
              class="icon-button"
              data-size="sm"
              data-variant="ghost"
              commandfor={albumMenuId}
              command="show-modal"
              title={`Open menu for ${album.title}`}
            >
              <svg aria-hidden="true" width="20" height="20"><use href="#icon-menu"></use></svg>
            </button>
          </span>
        </article>
      {:else}
        {#if !loading}
          <div class="empty-state">
            <p class="type-body">
              {offlineMode ? "No downloaded albums." : "No albums found."}
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
        {libraryAvailable ? "Artist not found." : "Connect your library."}
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
{#if libraryAvailable && artist}
  <dialog
    id="artist-page-menu"
    class="action-menu"
    aria-labelledby="artist-page-menu-title"
    closedby="closerequest"
    data-swipedown="close"
    onclick={(event) => event.currentTarget.close()}
  >
    <div class="stack-sm">
      <header id="artist-page-menu-title" class="type-title">{artist.name}</header>
      <div class="wings">
        <button
          class="wings-item row-button"
          onclick={() => void playback.replaceQueueAndPlay(availableTrackIds(tracks))}
        >
          <svg aria-hidden="true" width="20" height="20"><use href="#icon-play"></use></svg>
          <span>Play</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => void playback.enqueue(availableTrackIds(tracks), "next")}
        >
          <svg aria-hidden="true" width="20" height="20"><use href="#icon-next"></use></svg>
          <span>Play next</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => void playback.enqueue(availableTrackIds(tracks), "last")}
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
  {#each visibleAlbums as album, index}
    {@const albumMenuId = `album-menu-${index}`}
    {@const albumTracks = cache.albumTracks.get(album.id) ?? []}
    {@const visibleTrackIds = availableTrackIds(albumTracks)}
    <dialog
      id={albumMenuId}
      class="action-menu"
      aria-labelledby={`${albumMenuId}-title`}
      closedby="closerequest"
      data-swipedown="close"
      onclick={(event) => event.currentTarget.close()}
    >
      <div class="stack-sm">
        <header id={`${albumMenuId}-title`} class="type-title">{album.title}</header>
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
            onclick={() => albumTracks.forEach((track) => void trackEngine.download(track.id))}
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
