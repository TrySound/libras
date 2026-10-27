<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache, Immutable } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
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
  const menuTrackIds = $derived(menuTrack ? [menuTrack.id] : visibleTrackIds);
  const menuDownloadIds = $derived(
    menuTrack ? [menuTrack.id] : albumTracks.map((track) => track.id),
  );
  const menuDownloadStatus = $derived(menuTrack ? trackEngine.getStatus(menuTrack.id) : undefined);

  let sheet: HTMLDialogElement;
  let popover: HTMLDivElement;
  function dismissActions() {
    sheet.close();
    popover.hidePopover?.();
  }
</script>

<section class="ui-edgerunner split-layout" aria-label="Album details">
  {#if libraryAvailable && artist && album}
    <div class="viewport-panel">
      <Artwork
        {covers}
        id={album.artworkId}
        size="cover"
        loading="eager"
        class="viewport-panel-cover"
      />
      <div class="stack-sm">
        <div class="row-md row-justify">
          <div class="stack-xs">
            <h1 class="heading-xl">{album.title}</h1>
            <a
              class="button-quiet caption text-secondary"
              href={`#/library/artist/${encodeURIComponent(artist.id)}`}
              >{album.displayArtist ?? artist.name}</a
            >
          </div>
          <div class="row-sm">
            <button
              class="button"
              data-variant="primary"
              aria-label={`Play ${album.title}`}
              disabled={!visibleTrackIds.length}
              onclick={() => void playback.replaceQueueAndPlay(visibleTrackIds)}
              ><Icon name="play" size={24} /></button
            >
            <button
              class="button only-mobile"
              data-variant="secondary"
              commandfor="album-detail-menu"
              command="show-modal"
              aria-label={`Actions for ${album.title}`}
              onclick={() => (menuTrackId = undefined)}><Icon name="menu" size={24} /></button
            >
            <button
              class="button only-desktop"
              data-variant="secondary"
              commandfor="album-detail-menu-popover"
              command="toggle-popover"
              aria-label={`Actions for ${album.title}`}
              onclick={() => (menuTrackId = undefined)}><Icon name="menu" size={24} /></button
            >
          </div>
        </div>
        <p class="caption text-secondary">
          {[
            album.year ?? "Unknown year",
            ...album.genres,
            `${visibleTracks.length} track${visibleTracks.length === 1 ? "" : "s"}`,
            ...(totalDuration ? [`${Math.ceil(totalDuration / 60)} min`] : []),
          ].join(" · ")}
        </p>
      </div>
    </div>
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
              <button
                class="button only-mobile"
                data-variant="secondary"
                commandfor="album-detail-menu"
                command="show-modal"
                aria-label={`Actions for ${track.title}`}
                onclick={() => (menuTrackId = track.id)}><Icon name="menu" size={24} /></button
              >
              <button
                class="button only-desktop"
                data-variant="secondary"
                commandfor="album-detail-menu-popover"
                command="toggle-popover"
                aria-label={`Actions for ${track.title}`}
                onclick={() => (menuTrackId = track.id)}><Icon name="menu" size={24} /></button
              >
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

<dialog
  bind:this={sheet}
  id="album-detail-menu"
  class="ui-edgerunner bottom-sheet action-menu"
  aria-labelledby="album-detail-menu-title"
  closedby="closerequest"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render actions("album-detail-menu", false)}
</dialog>
<div
  bind:this={popover}
  id="album-detail-menu-popover"
  class="ui-edgerunner popover"
  popover="auto"
  role="dialog"
  aria-labelledby="album-detail-menu-popover-title"
>
  {@render actions("album-detail-menu-popover", true)}
</div>

{#snippet actions(target: string, isPopover: boolean)}
  <div class="stack-lg">
    <header class="row-md row-justify">
      <div class="row-md">
        <Artwork {covers} id={menuTrack?.artworkId ?? album?.artworkId} size="lg" />
        <h2 id={`${target}-title`} class="heading-md">{menuTrack?.title ?? album?.title}</h2>
      </div>
      <button
        class="button"
        commandfor={target}
        command={isPopover ? "hide-popover" : "close"}
        aria-label="Close menu"><Icon name="cross" size={24} /></button
      >
    </header>
    <div class="stack-sm">
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          if (menuTrack) playTrack(menuTrack);
          else void playback.replaceQueueAndPlay(menuTrackIds);
          dismissActions();
        }}><Icon name="play" size={24} /><span>Play</span></button
      >
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.enqueue(menuTrackIds, "next");
          dismissActions();
        }}><Icon name="next" size={24} /><span>Play next</span></button
      >
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.enqueue(menuTrackIds, "last");
          dismissActions();
        }}><Icon name="plus" size={24} /><span>Play last</span></button
      >
      <button
        class="menu-item"
        disabled={!menuDownloadIds.length ||
          (menuDownloadStatus !== undefined && menuDownloadStatus !== "idle")}
        onclick={() => {
          trackEngine.downloadMany(menuDownloadIds);
          dismissActions();
        }}
      >
        <Icon
          name={menuDownloadStatus === "downloaded"
            ? "check"
            : menuDownloadStatus === "queued"
              ? "clock"
              : menuDownloadStatus === "downloading"
                ? "loading"
                : "download"}
          size={24}
        />
        <span
          >{menuDownloadStatus === "downloaded"
            ? "Downloaded"
            : menuDownloadStatus === "queued"
              ? "Queued"
              : menuDownloadStatus === "downloading"
                ? "Downloading…"
                : "Download"}</span
        >
      </button>
    </div>
  </div>
{/snippet}
