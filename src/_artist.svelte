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
    playback: Playback;
  }

  let { params, cache, covers, trackEngine, session, playback }: Props = $props();

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

<section>
  {#if libraryAvailable && artist}
    <div class="view collection-view">
      <Artwork
        {covers}
        id={artist.artworkId}
        variant="artwork"
        loading="eager"
        viewTransitionName={`artist-cover-${artist.id}`}
      />
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
    </div>
    <div class="wings">
      {#each visibleAlbums as album, index}
        {@const albumMenuId = `album-menu-${index}`}
        {@const visibleTrackIds = availableTrackIds(cache.albumTracks.get(album.id) ?? [])}
        <article class="wings-item row-button">
          <a
            class="linkarea"
            href={`#/library/artist/${encodeURIComponent(artist.id)}/album/${encodeURIComponent(album.id)}`}
            aria-label={`Open ${album.title}`}
            data-longpressfor={albumMenuId}
            data-longpress="show-modal"
            title={`${album.title} — hold for actions`}
          ></a>
          <Artwork {covers} id={album.artworkId} viewTransitionName={`album-cover-${album.id}`} />
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
    <div class="wings">
      <header class="topbar wings-item">
        <button class="icon-button" data-size="sm" data-variant="ghost" title="Close menu">
          <svg class="self-center" aria-hidden="true" width="20" height="20"
            ><use href="#icon-chevron-down"></use></svg
          >
        </button>
        <span id="artist-page-menu-title" class="type-title">{artist.name}</span>
      </header>
      <button
        class="wings-item row-button"
        onclick={() => void playback.replaceQueueAndPlay(availableTrackIds(tracks))}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-play"></use></svg
        >
        <span>Play</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => void playback.enqueue(availableTrackIds(tracks), "next")}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-next"></use></svg
        >
        <span>Play next</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => void playback.enqueue(availableTrackIds(tracks), "last")}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-plus"></use></svg
        >
        <span>Play last</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => tracks.forEach((track) => void trackEngine.download(track.id))}
      >
        <svg class="self-center" aria-hidden="true" width="20" height="20"
          ><use href="#icon-download"></use></svg
        >
        <span>Download</span>
      </button>
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
      <div class="wings">
        <header class="topbar wings-item">
          <button class="icon-button" data-size="sm" data-variant="ghost" title="Close menu">
            <svg class="self-center" aria-hidden="true" width="20" height="20"
              ><use href="#icon-chevron-down"></use></svg
            >
          </button>
          <span id={`${albumMenuId}-title`} class="type-title">{album.title}</span>
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
          onclick={() => albumTracks.forEach((track) => void trackEngine.download(track.id))}
        >
          <svg class="self-center" aria-hidden="true" width="20" height="20"
            ><use href="#icon-download"></use></svg
          >
          <span>Download</span>
        </button>
      </div>
    </dialog>
  {/each}
{/if}
