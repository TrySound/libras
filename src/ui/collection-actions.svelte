<script lang="ts">
  import Icon from "../icon.svelte";
  import Artwork from "./artwork.svelte";
  import type { Covers } from "../covers.svelte";
  import type { Playback } from "../playback.svelte";
  import type { TrackEngine } from "../track.svelte";

  let {
    id,
    title,
    artworkId,
    covers,
    playback,
    trackEngine,
    trackIds,
    downloadIds,
    onplay,
    downloadStatus,
  } = $props<{
    id: string;
    title?: string;
    artworkId?: string;
    covers: Covers;
    playback: Playback;
    trackEngine: TrackEngine;
    trackIds: string[];
    downloadIds: string[];
    onplay?: () => void;
    downloadStatus?: "idle" | "queued" | "downloading" | "downloaded";
  }>();

  let sheet: HTMLDialogElement;
  let popover: HTMLDivElement;
  function dismiss() {
    sheet.close();
    popover.hidePopover?.();
  }
</script>

<dialog
  bind:this={sheet}
  {id}
  class="ui-edgerunner bottom-sheet action-menu"
  aria-labelledby={`${id}-title`}
  closedby="closerequest"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render actions(id, false)}
</dialog>
<div
  bind:this={popover}
  id={`${id}-popover`}
  class="ui-edgerunner popover"
  popover="auto"
  role="dialog"
  aria-labelledby={`${id}-popover-title`}
>
  {@render actions(`${id}-popover`, true)}
</div>

{#snippet actions(target: string, isPopover: boolean)}
  <div class="stack-lg">
    <header class="row-md row-justify">
      <div class="row-md">
        <Artwork {covers} id={artworkId} size="lg" />
        <h2 id={`${target}-title`} class="heading-md">{title}</h2>
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
        disabled={!trackIds.length}
        onclick={() => {
          if (onplay) onplay();
          else void playback.replaceQueueAndPlay(trackIds);
          dismiss();
        }}><Icon name="play" size={24} /><span>Play</span></button
      >
      <button
        class="menu-item"
        disabled={!trackIds.length}
        onclick={() => {
          void playback.enqueue(trackIds, "next");
          dismiss();
        }}><Icon name="next" size={24} /><span>Play next</span></button
      >
      <button
        class="menu-item"
        disabled={!trackIds.length}
        onclick={() => {
          void playback.enqueue(trackIds, "last");
          dismiss();
        }}><Icon name="plus" size={24} /><span>Play last</span></button
      >
      <button
        class="menu-item"
        disabled={!downloadIds.length ||
          (downloadStatus !== undefined && downloadStatus !== "idle")}
        onclick={() => {
          trackEngine.downloadMany(downloadIds);
          dismiss();
        }}
      >
        <Icon
          name={downloadStatus === "downloaded"
            ? "check"
            : downloadStatus === "queued"
              ? "clock"
              : downloadStatus === "downloading"
                ? "loading"
                : "download"}
          size={24}
        />
        <span
          >{downloadStatus === "downloaded"
            ? "Downloaded"
            : downloadStatus === "queued"
              ? "Queued"
              : downloadStatus === "downloading"
                ? "Downloading…"
                : "Download"}</span
        >
      </button>
    </div>
  </div>
{/snippet}
