<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
  import CollectionPanel from "./ui/collection-panel.svelte";
  import ActionTrigger from "./ui/action-trigger.svelte";
  import CollectionActions from "./ui/collection-actions.svelte";
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

  let menuAlbumId = $state<string>();
  const menuAlbum = $derived(menuAlbumId ? cache.albums.get(menuAlbumId) : undefined);
  const menuTracks = $derived(menuAlbum ? (cache.albumTracks.get(menuAlbum.id) ?? []) : tracks);
  const menuTitle = $derived(menuAlbum?.title ?? artist?.name);
  const menuArtwork = $derived(menuAlbum ? menuAlbum.artworkId : artist?.artworkId);
</script>

<section class="ui-edgerunner split-layout" aria-label="Artist details">
  {#if libraryAvailable && artist}
    <CollectionPanel
      {covers}
      artworkId={artist.artworkId}
      title={artist.name}
      metadata={[
        `${visibleAlbums.length} album${visibleAlbums.length === 1 ? "" : "s"}`,
        ...genres,
      ].join(" · ")}
    >
      {#snippet actions()}
        <button
          class="button"
          data-variant="primary"
          aria-label={`Play ${artist.name}`}
          disabled={!availableTrackIds(tracks).length}
          onclick={() => void playback.replaceQueueAndPlay(availableTrackIds(tracks))}
          ><Icon name="play" size={24} /></button
        >
        <ActionTrigger
          title={artist.name}
          menuId="artist-detail-menu"
          onselect={() => (menuAlbumId = undefined)}
        />
      {/snippet}
    </CollectionPanel>
    <div class="stack-lg scroll-runway">
      <h2 class="heading-lg uppercase">{offlineMode ? "Downloaded albums" : "Albums"}</h2>
      <div class="stack-sm">
        {#each visibleAlbums as album (album.id)}
          {@const ids = availableTrackIds(cache.albumTracks.get(album.id) ?? [])}
          <article class="menu-item track-row">
            <div class="row-sm">
              <Artwork {covers} id={album.artworkId} size="sm" />
              <div>
                <p class="label">{album.title}</p>
                <p class="caption text-secondary">
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
              <ActionTrigger
                title={album.title}
                menuId="artist-detail-menu"
                onselect={() => (menuAlbumId = album.id)}
              />
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

<CollectionActions
  id="artist-detail-menu"
  title={menuTitle}
  artworkId={menuArtwork}
  {covers}
  {playback}
  {trackEngine}
  trackIds={availableTrackIds(menuTracks)}
  downloadIds={menuTracks.map((track) => track.id)}
/>
