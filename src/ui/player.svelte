<script lang="ts">
  import Icon from "../icon.svelte";
  import Artwork from "./artwork.svelte";
  import Loader from "./loader.svelte";
  import type { Covers } from "../covers.svelte";
  import type { Cache } from "../cache.svelte";
  import type { Playback } from "../playback.svelte";
  import type AudioPlayer from "../audio-player.svelte";
  import { formatTime } from "../time";

  interface Props {
    cache: Cache;
    covers: Covers;
    playback: Playback;
    audio: ReturnType<typeof AudioPlayer> | undefined;
  }

  let { cache, covers, playback, audio }: Props = $props();
  const id = $props.id();
  const track = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const artist = $derived(
    track && (track.displayArtist ?? cache.artists.get(track.artistIds[0])?.name),
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
      aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
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
        <small id={`${id}-artist`} class="caption text-secondary truncate">{artist ?? ""}</small>
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
