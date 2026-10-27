<script lang="ts">
  import Icon from "../icon.svelte";
  import Artwork from "./artwork.svelte";
  import Loader from "./loader.svelte";
  import type { Covers } from "../covers.svelte";

  interface Props {
    covers: Covers;
    artworkId?: string;
    title: string;
    artist?: string;
    playing: boolean;
    loading: boolean;
    position: number;
    duration: number;
    positionText: string;
    hasPrevious: boolean;
    hasNext: boolean;
    ontoggle: () => void;
    onprevious: () => void;
    onnext: () => void;
    onseek: (position: number) => void;
  }

  let {
    covers,
    artworkId,
    title,
    artist,
    playing,
    loading,
    position,
    duration,
    positionText,
    hasPrevious,
    hasNext,
    ontoggle,
    onprevious,
    onnext,
    onseek,
  }: Props = $props();
  const id = $props.id();
  const maximum = $derived(Number.isFinite(duration) && duration > 0 ? duration : 0);
  const value = $derived(Number.isFinite(position) ? Math.min(maximum, Math.max(0, position)) : 0);
</script>

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
    aria-valuetext={positionText}
    oninput={(event) => onseek(event.currentTarget.valueAsNumber)}
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
    <Artwork {covers} id={artworkId} loading="eager" />
    <span class="stack-xs">
      <strong id={`${id}-title`} class="label truncate">{title}</strong>
      <small id={`${id}-artist`} class="caption text-secondary truncate">{artist ?? ""}</small>
    </span>
  </button>
  <div class="row-md">
    <button
      class="button only-desktop"
      aria-label="Previous track"
      disabled={!hasPrevious}
      onclick={onprevious}
    >
      <Icon name="previous" size={24} />
    </button>
    <button
      class="button"
      data-variant="primary"
      aria-label={playing ? "Pause" : "Play"}
      aria-busy={loading}
      onclick={ontoggle}
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
      disabled={!hasNext}
      onclick={onnext}
    >
      <Icon name="next" size={24} />
    </button>
  </div>
</footer>
