<script lang="ts">
  import Icon from "../icon.svelte";
  import Artwork from "./artwork.svelte";
  import Loader from "./loader.svelte";
  import type { Covers } from "../covers.svelte";
  import type { Cache } from "../cache.svelte";
  import type { Playback } from "../playback.svelte";
  import type { TrackEngine } from "../track.svelte";
  import type AudioPlayer from "../audio-player.svelte";
  import { formatDuration } from "../time";

  interface Props {
    cache: Cache;
    covers: Covers;
    playback: Playback;
    trackEngine: TrackEngine;
    audio: ReturnType<typeof AudioPlayer> | undefined;
    offlineMode: boolean;
  }

  let { cache, covers, playback, trackEngine, audio, offlineMode }: Props = $props();
  const id = $props.id();
  const track = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const artist = $derived(track && cache.artists.get(track.artistIds[0]));
  const artistName = $derived(track && (track.displayArtist ?? artist?.name));
  const album = $derived(track && cache.albums.get(track.albumId));
  const albumArtist = $derived(album && cache.artists.get(album.artistIds[0]));
  const atmosphere = $derived(track?.artworkId ? covers.ensureCover(track.artworkId) : undefined);
  const queue = $derived(
    cache.queue.tracks.flatMap((id, index) => {
      const track = cache.tracks.get(id);
      return track && (!offlineMode || trackEngine.getStatus(id) === "downloaded")
        ? [{ track, index }]
        : [];
    }),
  );
  const playing = $derived(audio?.playing ?? false);
  const loading = $derived(["loading", "buffering", "seeking"].includes(audio?.status ?? "idle"));
  const duration = $derived(audio?.duration || track?.duration || 0);
  const maximum = $derived(Number.isFinite(duration) && duration > 0 ? duration : 0);
  const position = $derived(cache.queue.position);
  const value = $derived(Number.isFinite(position) ? Math.min(maximum, Math.max(0, position)) : 0);
</script>

{#if track}
  <footer class="mini-player app-player ui-edgerunner" aria-label="Music player">
    <input
      class="seek mini-player-seek"
      type="range"
      min="0"
      max={maximum || 1}
      step="any"
      {value}
      disabled={!maximum}
      style:--progress={`${maximum ? (value / maximum) * 100 : 0}%`}
      aria-label="Playback position"
      aria-valuetext={`${formatDuration(position)} of ${formatDuration(duration)}`}
      oninput={(event) => playback.seek(event.currentTarget.valueAsNumber)}
    />
    <progress
      class="playback-progress mini-player-progress"
      max={maximum || 1}
      {value}
      aria-label="Playback progress"
    ></progress>
    <button
      class="button-quiet row-sm"
      commandfor="player-dialog"
      command="show-modal"
      aria-label="Open Now Playing"
      aria-describedby={`${id}-title ${id}-artist`}
    >
      <Artwork {covers} id={track.artworkId} loading="eager" />
      <span class="stack-xs">
        <strong id={`${id}-title`} class="label truncate">{track.title}</strong>
        <small id={`${id}-artist`} class="caption text-secondary truncate">{artistName ?? ""}</small
        >
      </span>
    </button>
    <div class="row-md">
      <button
        class="button only-desktop"
        aria-label="Previous track"
        disabled={cache.queue.index <= 0 && position <= 0}
        onclick={() => playback.previous()}
      >
        <Icon name="previous" size={24} />
      </button>
      <button
        class="button"
        data-variant="primary"
        aria-label={playing ? "Pause" : "Play"}
        aria-busy={loading}
        onclick={() => playback.toggle()}
      >
        {#if loading}
          <Loader />
        {:else}
          <Icon name={playing ? "pause" : "play"} size={24} />
        {/if}
      </button>
      <button
        class="button only-desktop"
        aria-label="Next track"
        disabled={cache.queue.index >= cache.queue.tracks.length - 1}
        onclick={() => playback.next()}
      >
        <Icon name="next" size={24} />
      </button>
    </div>
  </footer>
{/if}

<dialog
  id="player-dialog"
  class="ui-edgerunner large-player"
  closedby="any"
  data-swipedown="close"
  aria-labelledby="playing-title"
>
  <div class="large-player-stage">
    <img
      class="atmosphere"
      src={atmosphere?.source}
      hidden={!atmosphere?.source}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
    <header class="topbar row-md row-justify">
      <span class="dialog-handle" aria-hidden="true"></span>
      <h2 id="playing-title" class="heading-md uppercase">Now Playing</h2>
      <button
        class="button"
        data-variant="ghost"
        commandfor="player-dialog"
        command="close"
        aria-label="Close player"><Icon name="cross" size={24} /></button
      >
    </header>
    <section class="split-layout large-player-content" aria-label="Playback and queue">
      <div class="viewport-panel">
        <Artwork
          {covers}
          id={track?.artworkId}
          size="cover"
          loading="eager"
          class="viewport-panel-cover"
        />
        <div class="stack-lg">
          <div class="stack-xs">
            <h1 class="heading-xl">{track?.title ?? "Nothing playing"}</h1>
            {#if track}
              <p class="caption text-secondary">
                {#if artist}
                  <a
                    class="button-quiet"
                    href={`#/library/artist/${encodeURIComponent(artist.id)}`}
                    onclick={(event) => event.currentTarget.closest("dialog")?.close()}
                    >{artistName}</a
                  >
                {:else}{artistName ?? ""}{/if}
                {#if album}
                  —
                  {#if albumArtist}
                    <a
                      class="button-quiet"
                      href={`#/library/artist/${encodeURIComponent(albumArtist.id)}/album/${encodeURIComponent(album.id)}`}
                      onclick={(event) => event.currentTarget.closest("dialog")?.close()}
                      >{album.title}</a
                    >
                  {:else}{album.title}{/if}
                {/if}
              </p>
              {#if track.genres.length}
                <div class="row-wrap caption text-secondary" aria-label="Genres">
                  {#each track.genres as genre}<span>{genre}</span>{/each}
                </div>
              {/if}
            {/if}
          </div>
          <div class="stack-md">
            <div>
              <input
                class="seek"
                type="range"
                min="0"
                max={maximum}
                step="0.1"
                {value}
                disabled={!maximum ||
                  (offlineMode && track && trackEngine.getStatus(track.id) !== "downloaded")}
                style:--progress={`${maximum ? (value / maximum) * 100 : 0}%`}
                aria-label="Playback position"
                aria-valuetext={`${formatDuration(position)} of ${formatDuration(duration)}`}
                oninput={(event) => playback.seek(event.currentTarget.valueAsNumber)}
              />
              <div class="row-sm row-justify metadata text-subtle">
                <span>{formatDuration(position)}</span><span>{formatDuration(duration)}</span>
              </div>
            </div>
            <div class="row-md row-center">
              <button
                class="button"
                data-size="lg"
                aria-label="Previous"
                disabled={cache.queue.index <= 0 && position <= 0}
                onclick={() => playback.previous()}><Icon name="previous" size={24} /></button
              >
              <button
                class="button"
                data-size="lg"
                data-variant="primary"
                aria-label={playing ? "Pause" : "Play"}
                aria-busy={loading}
                disabled={!queue.length}
                onclick={() => playback.toggle()}
              >
                {#if loading}<Loader />{:else}<Icon
                    name={playing ? "pause" : "play"}
                    size={24}
                  />{/if}
              </button>
              <button
                class="button"
                data-size="lg"
                aria-label="Next"
                disabled={cache.queue.index < 0 ||
                  cache.queue.index >= cache.queue.tracks.length - 1}
                onclick={() => playback.next()}><Icon name="next" size={24} /></button
              >
            </div>
          </div>
        </div>
      </div>
      <div class="stack-lg scroll-runway" aria-label="Queue">
        <div class="row-md row-justify">
          <div class="stack-xs">
            <h2 class="heading-lg uppercase">Up next</h2>
            <p class="metadata text-subtle">{queue.length} track{queue.length === 1 ? "" : "s"}</p>
          </div>
          {#if cache.queue.tracks.length}
            <button
              class="button"
              data-size="text"
              data-variant="secondary"
              onclick={() => playback.clearQueue()}>Clear</button
            >
          {/if}
        </div>
        <div class="stack-sm">
          {#each queue as { track, index }, visibleIndex (index)}
            {@const downloadStatus = trackEngine.getStatus(track.id)}
            {@const credit =
              track.displayArtist?.trim() ||
              track.artistIds
                .map((id) => cache.artists.get(id)?.name)
                .filter(Boolean)
                .join(", ")}
            <div
              class="menu-item track-row"
              aria-current={index === cache.queue.index ? "true" : undefined}
            >
              <span class="track-row-number metadata text-subtle">
                {#if index === cache.queue.index && loading}
                  <span role="img" aria-label="Loading playback"><Loader /></span>
                {:else if index === cache.queue.index && playing}
                  <span role="img" aria-label="Playing"
                    ><Icon name="sound-bars" size={24} color="var(--accent)" /></span
                  >
                {:else if index === cache.queue.index}
                  <span role="img" aria-label="Current track, not playing"
                    ><Icon name="pause" size={24} color="var(--accent)" /></span
                  >
                {:else if downloadStatus === "downloading"}
                  <span role="img" aria-label="Downloading"><Loader /></span>
                {:else if downloadStatus === "queued"}
                  <span role="img" aria-label="Queued for download"
                    ><Icon name="clock" size={24} /></span
                  >
                {:else}{String(visibleIndex + 1).padStart(2, "0")}{/if}
              </span>
              <div class="row-sm">
                <Artwork {covers} id={track.artworkId} size="sm" />
                <div>
                  <p class="label">{track.title}</p>
                  {#if credit}<p class="caption text-secondary">{credit}</p>{/if}
                </div>
              </div>
              <button
                class="button-quiet link-target"
                aria-label={`Play ${track.title}`}
                onclick={() => playback.playIndex(index)}
              ></button>
              <div class="row-sm">
                <span class="metadata text-subtle"
                  >{#if track.duration !== undefined}{formatDuration(track.duration)}{/if}</span
                >
              </div>
            </div>
          {:else}
            <p class="body">
              {cache.queue.tracks.length ? "No available tracks." : "The queue is empty."}
            </p>
          {/each}
        </div>
      </div>
    </section>
  </div>
</dialog>
