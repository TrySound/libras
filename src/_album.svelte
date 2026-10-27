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

  const durationFormatter = new Intl.DurationFormat("en", {
    minutes: "numeric",
    seconds: "2-digit",
  });

  interface Props {
    params: RouteParams;
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playbackState: "loading" | "playing" | "paused";
    playback: Playback;
  }

  let { params, cache, covers, trackEngine, session, playbackState, playback }: Props = $props();

  const offlineMode = $derived(session.offlineMode);
  const loading = $derived(!session.localReady);
  const libraryAvailable = $derived(cache.savedAt !== undefined);
  const currentTrack = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const artist = $derived(params.artistId ? cache.artists.get(params.artistId) : undefined);
  const album = $derived(params.albumId ? cache.albums.get(params.albumId) : undefined);
  const visibleTracks = $derived(
    album
      ? offlineMode
        ? (cache.albumTracks.get(album.id) ?? []).filter(
            (track) => trackEngine.getStatus(track.id) === "downloaded",
          )
        : (cache.albumTracks.get(album.id) ?? [])
      : [],
  );
  const visibleTrackIds = $derived(visibleTracks.map((track) => track.id));

  function playTrack(track: Immutable<Track>) {
    void playback.replaceQueueAndPlay(visibleTrackIds, visibleTrackIds.indexOf(track.id));
  }

  let menuTrackId = $state<string>();
  const menuTrack = $derived(menuTrackId ? cache.tracks.get(menuTrackId) : undefined);
  const albumTracks = $derived(album ? (cache.albumTracks.get(album.id) ?? []) : []);
  const totalDuration = $derived(
    visibleTracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
  );
</script>

<section class="ui-edgerunner split-layout" aria-label="Album details">
  {#if libraryAvailable && artist && album}
    <CollectionPanel
      {covers}
      artworkId={album.artworkId}
      title={album.title}
      credit={album.displayArtist ?? artist.name}
      href={`#/library/artist/${encodeURIComponent(artist.id)}`}
      metadata={[
        album.year ?? "Unknown year",
        ...album.genres,
        `${visibleTracks.length} track${visibleTracks.length === 1 ? "" : "s"}`,
        ...(totalDuration ? [`${Math.ceil(totalDuration / 60)} min`] : []),
      ].join(" · ")}
    >
      {#snippet actions()}
        <button
          class="button"
          data-variant="primary"
          aria-label={`Play ${album.title}`}
          disabled={!visibleTrackIds.length}
          onclick={() => void playback.replaceQueueAndPlay(visibleTrackIds)}
          ><Icon name="play" size={24} /></button
        >
        <ActionTrigger
          title={album.title}
          menuId="album-detail-menu"
          onselect={() => (menuTrackId = undefined)}
        />
      {/snippet}
    </CollectionPanel>
    <div class="stack-lg scroll-runway">
      <h2 class="heading-lg uppercase">{offlineMode ? "Downloaded tracks" : "Tracks"}</h2>
      <div class="stack-sm">
        {#each visibleTracks as track, index (track.id)}
          {@const downloadStatus = trackEngine.getStatus(track.id)}
          {@const credit =
            track.displayArtist?.trim() ||
            track.artistIds
              .map((id) => cache.artists.get(id)?.name)
              .filter(Boolean)
              .join(", ")}
          <div
            class="menu-item track-row"
            aria-current={currentTrack?.id === track.id ? "true" : undefined}
          >
            <span class="track-row-number metadata text-subtle">
              {#if currentTrack?.id === track.id && playbackState === "loading"}
                <span role="img" aria-label="Loading playback"
                  ><Icon name="loading" size={24} /></span
                >
              {:else if currentTrack?.id === track.id && playbackState === "playing"}
                <span role="img" aria-label="Playing"
                  ><Icon name="sound-bars" size={24} color="var(--accent)" /></span
                >
              {:else if downloadStatus === "downloading"}
                <span role="img" aria-label="Downloading"><Icon name="loading" size={24} /></span>
              {:else if downloadStatus === "queued"}
                <span role="img" aria-label="Queued for download"
                  ><Icon name="clock" size={24} /></span
                >
              {:else}{String(track.number ?? index + 1).padStart(2, "0")}{/if}
            </span>
            <div class="row-sm">
              <Artwork {covers} id={track.artworkId ?? album.artworkId} size="sm" />
              <div>
                <p class="label">{track.title}</p>
                {#if credit && credit !== (album.displayArtist ?? artist.name).trim()}<p
                    class="caption text-secondary"
                  >
                    {credit}
                  </p>{/if}
              </div>
            </div>
            <button
              class="button-quiet link-target"
              aria-label={`Play ${track.title}`}
              onclick={() => playTrack(track)}
              data-longpressfor="album-detail-menu"
              data-longpress="show-modal"
              onfocus={() => (menuTrackId = track.id)}
            ></button>
            <div class="row-sm">
              <span class="metadata text-subtle">
                {#if track.duration !== undefined}{durationFormatter.format({
                    minutes: Math.floor(track.duration / 60),
                    seconds: Math.floor(track.duration % 60),
                  })}{/if}
              </span>
              <ActionTrigger
                title={track.title}
                menuId="album-detail-menu"
                onselect={() => (menuTrackId = track.id)}
              />
            </div>
          </div>
        {:else}
          {#if !loading}<p class="body">
              {offlineMode ? "No downloaded tracks." : "No tracks found."}
            </p>{/if}
        {/each}
      </div>
    </div>
  {:else if !loading}
    <div class="stack-md scroll-runway">
      <h1 class="heading-sm">{libraryAvailable ? "Album not found." : "Connect your library."}</h1>
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
  id="album-detail-menu"
  title={menuTrack?.title ?? album?.title}
  artworkId={menuTrack?.artworkId ?? album?.artworkId}
  {covers}
  {playback}
  {trackEngine}
  trackIds={menuTrack ? [menuTrack.id] : visibleTrackIds}
  downloadIds={menuTrack ? [menuTrack.id] : albumTracks.map((track) => track.id)}
  onplay={menuTrack ? () => playTrack(menuTrack) : undefined}
  downloadStatus={menuTrack ? trackEngine.getStatus(menuTrack.id) : undefined}
/>
