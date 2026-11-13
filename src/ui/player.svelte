<script lang="ts">
  import Icon from "../icon.svelte";
  import { tick } from "svelte";
  import Artwork from "./artwork.svelte";
  import Atmosphere from "./atmosphere.svelte";
  import Loader from "./loader.svelte";
  import type { Covers } from "../covers.svelte";
  import type { Cache } from "../cache.svelte";
  import type { Playback } from "../playback.svelte";
  import type { TrackEngine } from "../track.svelte";
  import type { AudioTransport } from "../audio-transport.svelte";
  import { formatDuration } from "../time";

  interface Props {
    cache: Cache;
    covers: Covers;
    playback: Playback;
    trackEngine: TrackEngine;
    audio: AudioTransport | undefined;
    offlineMode: boolean;
    serverQueueExchange?: boolean;
  }

  let {
    cache,
    covers,
    playback,
    trackEngine,
    audio,
    offlineMode,
    serverQueueExchange = true,
  }: Props = $props();
  let removalMessage = $state("");
  async function removeOccurrence(index: number) {
    const selected = index === cache.queue.index;
    playback.removeQueueIndex(index);
    removalMessage = selected ? "Track removed. Playback stopped." : "Track removed.";
    await tick();
    const next = Math.min(index, cache.queue.tracks.length - 1);
    document.getElementById(next >= 0 ? `${id}-remove-${next}` : `${id}-queue`)?.focus();
  }
  const canExchange = $derived(serverQueueExchange && playback.canExchangeQueue);
  const id = $props.id();
  const track = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const artist = $derived(track && cache.artists.get(track.artistIds[0]));
  const artistName = $derived(track && (track.displayArtist ?? artist?.name));
  const album = $derived(track && cache.albums.get(track.albumId));
  const atmosphere = $derived(track?.artworkId ? covers.ensureCover(track.artworkId) : undefined);
  const queue = $derived(
    cache.queue.tracks.map((id, index) => ({ id, track: cache.tracks.get(id), index })),
  );
  // Batch layout work while retaining every queue occurrence and its original playback index.
  const queueGroupSize = 40;
  const queueGroups = $derived(
    Array.from({ length: Math.ceil(queue.length / queueGroupSize) }, (_, index) =>
      queue.slice(index * queueGroupSize, (index + 1) * queueGroupSize),
    ),
  );
  const playing = $derived(audio?.playing ?? false);
  const loading = $derived(["loading", "buffering", "seeking"].includes(audio?.status ?? "idle"));
  const duration = $derived(audio?.duration || track?.duration || 0);
  const maximum = $derived(Number.isFinite(duration) && duration > 0 ? duration : 0);
  const position = $derived(cache.queue.position);
  const value = $derived(Number.isFinite(position) ? Math.min(maximum, Math.max(0, position)) : 0);
</script>

{#if track}
  <footer class="mini-player app-player view-shell" aria-label="Music player">
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
        <small id={`${id}-artist`} class="caption text-secondary truncate">
          {artistName ?? ""}
        </small>
      </span>
    </button>
    <div class="row-md">
      <button
        class="button only-desktop"
        aria-label="Previous track"
        disabled={cache.queue.index <= 0 && position <= 0}
        onclick={() => playback.previous()}
      >
        <Icon name="previous" />
      </button>
      <button
        class="button"
        data-variant="primary"
        aria-label={playing || loading ? "Pause" : "Play"}
        aria-describedby={`${id}-title`}
        aria-busy={loading}
        onclick={() => playback.toggle()}
      >
        {#if loading}
          <Loader />
        {:else}
          <Icon name={playing ? "pause" : "play"} />
        {/if}
      </button>
      <button
        class="button only-desktop"
        aria-label="Next track"
        disabled={cache.queue.index >= cache.queue.tracks.length - 1}
        onclick={() => playback.next()}
      >
        <Icon name="next" />
      </button>
    </div>
  </footer>
{/if}

<dialog
  id="player-dialog"
  class="large-player"
  closedby="any"
  data-swipedown="close"
  aria-labelledby="playing-title"
>
  <div class="large-player-stage">
    <Atmosphere src={atmosphere?.source} />
    <header class="topbar row-md row-justify">
      <span class="dialog-handle only-mobile" data-side="top" aria-hidden="true"></span>
      <h2 id="playing-title" class="heading-md uppercase">Now Playing</h2>
      <button
        class="button"
        data-variant="ghost"
        commandfor="player-dialog"
        command="close"
        aria-label="Close player"
      >
        <Icon name="cross" />
      </button>
    </header>
    <section class="split-layout large-player-content" aria-label="Playback and queue">
      <div class="player-panel">
        <Artwork {covers} id={track?.artworkId} size="cover" loading="eager" />
        <div class="stack-lg">
          <div class="stack-xs">
            <h1 id={`${id}-now-title`} class="heading-lg uppercase">
              {track?.title ?? "Nothing playing"}
            </h1>
            {#if track}
              <p class="caption text-secondary">
                {#if artist}
                  <a
                    class="button-quiet"
                    href={`?/library/artist/${encodeURIComponent(artist.id)}`}
                    onclick={(event) => event.currentTarget.closest("dialog")?.close()}
                  >
                    <span class="label">{artistName}</span>
                  </a>
                {:else}
                  <span class="label">{artistName ?? ""}</span>
                {/if}
                {#if album}
                  ·
                  <a
                    class="button-quiet"
                    href={`?/library/album/${encodeURIComponent(album.id)}`}
                    onclick={(event) => event.currentTarget.closest("dialog")?.close()}
                  >
                    <span class="label">{album.title}</span>
                  </a>
                {/if}
              </p>
              {#if track.genres.length}
                <p class="caption text-secondary" role="group" aria-label="Genres">
                  {track.genres.join(" · ")}
                </p>
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
                disabled={!maximum || (offlineMode && track && !trackEngine.isDownloaded(track.id))}
                style:--progress={`${maximum ? (value / maximum) * 100 : 0}%`}
                aria-label="Playback position"
                aria-valuetext={`${formatDuration(position)} of ${formatDuration(duration)}`}
                oninput={(event) => playback.seek(event.currentTarget.valueAsNumber)}
              />
              <div class="row-sm row-justify metadata text-subtle">
                <span>{formatDuration(position)}</span>
                <span>{formatDuration(duration)}</span>
              </div>
            </div>
            <div class="player-controls row-xs row-justify">
              <div class="button-hidden-stub" aria-hidden="true"></div>
              <div class="row-md" role="group" aria-label="Playback controls">
                <button
                  class="button"
                  aria-label="Previous"
                  disabled={cache.queue.index <= 0 && position <= 0}
                  onclick={() => playback.previous()}
                >
                  <Icon name="previous" size="lg" />
                </button>
                <button
                  class="button"
                  data-variant="primary"
                  aria-label={playing || loading ? "Pause" : "Play"}
                  aria-describedby={`${id}-now-title`}
                  aria-busy={loading}
                  disabled={!queue.length}
                  onclick={() => playback.toggle()}
                >
                  {#if loading}
                    <Loader size="lg" />
                  {:else}
                    <Icon name={playing ? "pause" : "play"} size="lg" />
                  {/if}
                </button>
                <button
                  class="button"
                  aria-label="Next"
                  disabled={cache.queue.index < 0 ||
                    cache.queue.index >= cache.queue.tracks.length - 1}
                  onclick={() => playback.next()}
                >
                  <Icon name="next" size="lg" />
                </button>
              </div>
              <a class="button" href={`#${id}-queue`} aria-label="Show queue" title="Show queue">
                <Icon name="queue" />
              </a>
            </div>
          </div>
          {#if audio?.status === "error"}
            <div class="card stack-sm">
              <p class="caption" role="alert">
                {audio.error instanceof Error
                  ? audio.error.message
                  : String(audio.error ?? "Playback failed.")}
              </p>
              <button
                class="button"
                data-size="text"
                data-variant="secondary"
                onclick={() => void playback.play()}
              >
                Retry playback
              </button>
            </div>
          {/if}
        </div>
      </div>
      <div class="queue-panel stack-lg scroll-runway" role="region" aria-label="Queue">
        <div class="row-md row-justify">
          <div class="stack-xs">
            <h2 id={`${id}-queue`} class="heading-lg uppercase" tabindex="-1">Up next</h2>
            <p class="metadata text-subtle">{queue.length} track{queue.length === 1 ? "" : "s"}</p>
          </div>
          {#if cache.queue.tracks.length}
            <button
              class="button"
              data-size="text"
              data-variant="secondary"
              commandfor={`${id}-clear-confirmation`}
              command="show-modal"
            >
              Clear queue
            </button>
          {/if}
        </div>
        {#if cache.queue.index < 0 && queue.length}
          <button
            class="button"
            data-size="text"
            data-variant="primary"
            disabled={offlineMode && !trackEngine.isDownloaded(queue[0].id)}
            onclick={() => void playback.playIndex(0)}>Play</button
          >
        {/if}
        {#if removalMessage}<p class="caption" role="status">{removalMessage}</p>{/if}
        <div class="stack-sm">
          <div class="row-sm row-wrap">
            <button
              class="button"
              data-size="text"
              data-variant="secondary"
              disabled={!canExchange || !!playback.exchangeBusy}
              commandfor={`${id}-load-confirmation`}
              command="show-modal"
            >
              {playback.exchangeBusy === "load" ? "Loading…" : "Load server queue"}
            </button>
            <button
              class="button"
              data-size="text"
              data-variant="secondary"
              disabled={!canExchange || !!playback.exchangeBusy}
              onclick={() => {
                if (cache.queue.tracks.length) void playback.saveServerQueue();
                else
                  document
                    .getElementById(`${id}-save-confirmation`)
                    ?.closest("dialog")
                    ?.showModal();
              }}
            >
              {playback.exchangeBusy === "save" ? "Saving…" : "Save queue to server"}
            </button>
          </div>
          <p class="caption text-secondary">Server queues change only when you load or save.</p>
          {#if !canExchange}
            <p class="caption text-secondary">
              {serverQueueExchange
                ? "Connect to exchange server queues."
                : "Server queue exchange is unavailable in the demo."}
            </p>
          {/if}
          <p class="caption" role="status">{playback.exchangeMessage}</p>
          {#each queueGroups as group, groupIndex (groupIndex)}
            <div class="stack-sm track-group" style:--track-group-rows={group.length}>
              {#each group as { track, index, id: trackId }, rowIndex (index)}
                {#if track}
                  {@const visibleIndex = groupIndex * queueGroupSize + rowIndex}
                  {@const downloadStatus = trackEngine.getStatus(track.id)}
                  {@const credit =
                    track.displayArtist?.trim() ||
                    track.artistIds
                      .map((id) => cache.artists.get(id)?.name)
                      .filter(Boolean)
                      .join(", ")}
                  <div
                    class="menu-item track-row queue-row"
                    aria-current={index === cache.queue.index ? "true" : undefined}
                  >
                    <span class="track-row-number metadata text-subtle">
                      {#if index === cache.queue.index && loading}
                        <Loader />
                      {:else if index === cache.queue.index && playing}
                        <Icon name="sound-bars" color="var(--accent)" />
                      {:else if index === cache.queue.index}
                        <Icon name="play" color="var(--accent)" />
                      {:else if downloadStatus === "downloading"}
                        <span role="img" aria-label="Downloading">
                          <Loader />
                        </span>
                      {:else if downloadStatus === "queued"}
                        <span role="img" aria-label="Queued for download">
                          <Icon name="clock" />
                        </span>
                      {:else}
                        {String(visibleIndex + 1).padStart(2, "0")}
                      {/if}
                    </span>
                    <div class="row-sm queue-metadata">
                      <Artwork {covers} id={track.artworkId} size="sm" />
                      <div>
                        <p class="label">{track.title}</p>
                        {#if offlineMode && !trackEngine.isDownloaded(track.id)}
                          <p class="caption text-secondary" id={`${id}-unavailable-${index}`}>
                            Unavailable offline
                          </p>
                        {/if}
                        {#if credit}
                          <p class="caption text-secondary">{credit}</p>
                        {/if}
                      </div>
                    </div>
                    <button
                      class="button-quiet link-target"
                      aria-label={`${index === cache.queue.index && (playing || loading) ? "Pause" : "Play"} ${track.title}`}
                      disabled={offlineMode && !trackEngine.isDownloaded(track.id)}
                      aria-describedby={offlineMode && !trackEngine.isDownloaded(track.id)
                        ? `${id}-unavailable-${index}`
                        : undefined}
                      onclick={() => playback.toggleQueueIndex(index)}
                    ></button>
                    <div class="row-sm queue-actions">
                      <button
                        id={`${id}-remove-${index}`}
                        class="button"
                        data-size="text"
                        data-variant="secondary"
                        aria-label={`Remove ${track.title}, queue item ${index + 1}`}
                        onclick={() => void removeOccurrence(index)}>Remove</button
                      >
                      <span class="metadata text-subtle">
                        {#if track.duration !== undefined}
                          {formatDuration(track.duration)}
                        {/if}
                      </span>
                    </div>
                  </div>
                {:else}
                  <div class="menu-item track-row queue-row">
                    <span class="track-row-number metadata text-subtle">{index + 1}</span>
                    <div class="row-sm queue-metadata">
                      <Artwork {covers} size="sm" />
                      <div>
                        <p class="label">Track unavailable</p>
                        <p class="caption text-secondary">{trackId}</p>
                      </div>
                    </div>
                    <button
                      class="button queue-actions"
                      data-size="text"
                      data-variant="secondary"
                      id={`${id}-remove-${index}`}
                      aria-label={`Remove unavailable track, queue item ${index + 1}`}
                      onclick={() => void removeOccurrence(index)}>Remove</button
                    >
                  </div>
                {/if}
              {/each}
            </div>
          {:else}
            <p class="body">Your queue is empty.</p>
          {/each}
        </div>
      </div>
    </section>
  </div>
</dialog>

{#each ["load", "save"] as action}
  <dialog
    id={`${id}-${action}-confirmation`}
    class="dialog"
    closedby="any"
    aria-labelledby={`${id}-${action}-title`}
    aria-describedby={`${id}-${action}-description`}
  >
    <div class="stack-lg">
      <h2 id={`${id}-${action}-title`} class="heading-md">
        {action === "load" ? "Replace this device’s queue?" : "Clear the server queue?"}
      </h2>
      <p id={`${id}-${action}-description`} class="body">
        {action === "load"
          ? "Loads the server queue without playing it. Your current queue will be replaced. Any active playback will stop."
          : "This device’s queue is empty. Saving it will replace the server queue with an empty queue."}
      </p>
      <div class="row-md row-end row-wrap">
        <!-- svelte-ignore a11y_autofocus (Safe initial action for a destructive confirmation.) -->
        <button
          class="button"
          data-size="text"
          data-variant="secondary"
          commandfor={`${id}-${action}-confirmation`}
          command="close"
          autofocus>Cancel</button
        >
        <button
          class="button"
          data-size="text"
          data-variant="primary"
          disabled={!canExchange ||
            !!playback.exchangeBusy ||
            (action === "save" && !!cache.queue.tracks.length)}
          onclick={(event) => {
            // Close before publishing busy state disables this invoker.
            event.currentTarget.closest("dialog")?.close();
            if (action === "load") void playback.loadServerQueue();
            else void playback.saveServerQueue();
          }}
        >
          {action === "load" ? "Load server queue" : "Clear server queue"}
        </button>
      </div>
    </div>
  </dialog>
{/each}

<dialog
  id={`${id}-clear-confirmation`}
  class="dialog"
  closedby="any"
  aria-labelledby={`${id}-clear-title`}
  aria-describedby={`${id}-clear-description`}
>
  <div class="stack-lg">
    <h2 id={`${id}-clear-title`} class="heading-md">Clear queue?</h2>
    <p id={`${id}-clear-description`} class="body">
      This will stop playback and remove all queued tracks.
    </p>
    <div class="row-md row-end row-wrap">
      <!-- svelte-ignore a11y_autofocus (Safe initial action for a destructive confirmation.) -->
      <button
        class="button"
        data-size="text"
        data-variant="secondary"
        commandfor={`${id}-clear-confirmation`}
        command="close"
        autofocus>Cancel</button
      >
      <button
        class="button"
        data-size="text"
        data-variant="primary"
        commandfor={`${id}-clear-confirmation`}
        command="close"
        onclick={() => {
          document.getElementById("player-dialog")?.closest("dialog")?.close();
          playback.clearQueue();
        }}>Clear queue</button
      >
    </div>
  </div>
</dialog>

<style>
  .queue-panel {
    container: queue / inline-size;
  }

  @container queue (width <= 30rem) {
    .queue-row.track-row:has(> .track-row-number) {
      grid-template-columns: max(3ch, 24px) minmax(0, 1fr);
    }

    .queue-metadata {
      grid-column: 2;
    }

    .queue-actions {
      grid-column: 2;
      justify-self: start;
    }
  }
</style>
