<script lang="ts">
  import Icon from "./icon.svelte";
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
  const genres = $derived([...new Set(albums.flatMap((album) => album.genres))]);

  function availableTrackIds(items: readonly Immutable<Track>[]) {
    return items
      .filter((track) => !offlineMode || trackEngine.getStatus(track.id) === "downloaded")
      .map((track) => track.id);
  }
</script>

<section>
  {#if libraryAvailable && artist}
    <div class="view container collection-view">
      <div class="collection-artwork">
        <Artwork {covers} id={artist.artworkId} size="stretch" loading="eager" />
      </div>
      <div class="row-md collection-heading">
        <div class="stack-xs grow">
          <h2 class="type-heading">
            {artist.name}
          </h2>
          <p class="library-meta type-small">
            {visibleAlbums.length} album{visibleAlbums.length === 1 ? "" : "s"}
          </p>
          {#if genres.length > 0}
            <div class="row-wrap-sm">
              {#each genres as genre}
                <span class="chip type-caption">{genre}</span>
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
          <Icon name="menu" />
        </button>
      </div>

      {#if loading}
        <div class="empty-state stack-md">
          <div class="scan-spinner">
            <Icon name="loading" />
          </div>
          <p class="type-body text-muted">Restoring local library…</p>
        </div>
      {/if}
    </div>
    <div class="container wings">
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
          <Artwork {covers} id={album.artworkId} />
          <span class="stack-xs">
            <strong class="type-title">{album.title}</strong>
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
            <Icon name="menu" />
          </button>
        </article>
      {:else}
        {#if !loading}
          <div class="empty-state stack-md">
            <p class="type-body text-muted">
              {offlineMode ? "No downloaded albums." : "No albums found."}
            </p>
          </div>
        {/if}
      {/each}
    </div>
  {:else if !loading}
    <div class="empty-state stack-md">
      <Artwork {covers} />
      <p class="type-body text-muted">
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
          <Icon name="chevron-down" class="self-center" />
        </button>
        <span id="artist-page-menu-title" class="type-title">{artist.name}</span>
      </header>
      <button
        class="wings-item row-button"
        onclick={() => void playback.replaceQueueAndPlay(availableTrackIds(tracks))}
      >
        <Icon name="play" class="self-center" />
        <span>Play</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => void playback.enqueue(availableTrackIds(tracks), "next")}
      >
        <Icon name="next" class="self-center" />
        <span>Play next</span>
      </button>
      <button
        class="wings-item row-button"
        onclick={() => void playback.enqueue(availableTrackIds(tracks), "last")}
      >
        <Icon name="plus" class="self-center" />
        <span>Play last</span>
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
            <Icon name="chevron-down" class="self-center" />
          </button>
          <span id={`${albumMenuId}-title`} class="type-title">{album.title}</span>
        </header>
        <button
          class="wings-item row-button"
          onclick={() => void playback.replaceQueueAndPlay(visibleTrackIds)}
        >
          <Icon name="play" class="self-center" />
          <span>Play</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => void playback.enqueue(visibleTrackIds, "next")}
        >
          <Icon name="next" class="self-center" />
          <span>Play next</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => void playback.enqueue(visibleTrackIds, "last")}
        >
          <Icon name="plus" class="self-center" />
          <span>Play last</span>
        </button>
        <button
          class="wings-item row-button"
          onclick={() => trackEngine.downloadMany(albumTracks.map((track) => track.id))}
        >
          <Icon name="download" class="self-center" />
          <span>Download</span>
        </button>
      </div>
    </dialog>
  {/each}
{/if}
