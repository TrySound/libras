<script lang="ts">
  import Icon from "./icon.svelte";
  import Artwork from "./ui/artwork.svelte";
  import Loader from "./ui/loader.svelte";
  import type { Cache } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import type { TrackEngine } from "./track.svelte";

  interface Props {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    loading: boolean;
  }

  let { cache, covers, trackEngine, loading }: Props = $props();

  const sizeFormatter = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  });
  const downloadError = $derived(
    trackEngine.error instanceof Error
      ? trackEngine.error.message
      : trackEngine.error
        ? String(trackEngine.error)
        : "",
  );

  const downloads = $derived.by(() => {
    const jobs = trackEngine.downloadJobs;
    const activeKeys = new Set(jobs.map((job) => job.key));
    const completed = [...cache.downloads]
      .filter(([key]) => !activeKeys.has(key))
      .sort(([aKey, a], [bKey, b]) => b.downloadedAt - a.downloadedAt || aKey.localeCompare(bKey))
      .map(([key, file]) => ({ ...file, key, status: "downloaded" as const }));
    return [...jobs, ...completed];
  });
</script>

<section class="ui-edgerunner downloads-view" aria-labelledby="downloads-heading">
  <div class="stack-lg scroll-runway">
    <header class="stack-sm">
      <h1 class="heading-xl" id="downloads-heading">Downloads</h1>
      <p class="body text-secondary">
        Downloading first, then queued tracks and saved files, newest first.
      </p>
    </header>

    {#if loading}
      <p class="row-sm label" role="status">
        <Loader />
        Restoring local library…
      </p>
    {/if}

    {#if downloadError}
      <div class="card stack-md">
        <h2 class="row-sm heading-sm">
          <span class="row-sm"><Icon name="cross" size={24} color="var(--error-text)" /></span>
          Download failed
        </h2>
        <p class="body">{downloadError}</p>
        <p class="body">
          Your saved files remain available. Open the library to try downloading again.
        </p>
        <div class="row-sm">
          <a class="button" data-variant="secondary" data-size="text" href="#/library"
            >Open library</a
          >
        </div>
      </div>
    {/if}

    {#if cache.error}
      <div class="card stack-md">
        <h2 class="heading-sm">Local storage needs attention</h2>
        <p class="body">
          Some local data could not be restored or saved. Available downloads are still listed here.
        </p>
      </div>
    {/if}

    {#if downloads.length}
      <div class="stack-sm" role="list" aria-label="Downloads" aria-busy={loading}>
        {#each downloads as entry (entry.key)}
          <div class="menu-item track-row" role="listitem">
            <span
              class="track-row-number row-sm"
              role="img"
              aria-label={entry.status === "downloading"
                ? "Downloading"
                : entry.status === "queued"
                  ? "Queued for download"
                  : "Downloaded"}
            >
              {#if entry.status === "downloading"}
                <Loader />
              {:else}
                <Icon
                  name={entry.status === "queued" ? "clock" : "check"}
                  size={24}
                  color={entry.status === "queued" ? "var(--text-subtle)" : "var(--accent)"}
                />
              {/if}
            </span>
            <div class="row-sm">
              <Artwork
                {covers}
                id={cache.tracks.get(entry.track.id)?.artworkId}
                size="sm"
                class="only-desktop"
              />
              <div>
                <p class="label">{entry.track.title}</p>
                <p class="caption text-secondary">{entry.track.artist} — {entry.track.album}</p>
                {#if entry.status === "downloaded"}
                  <p class="caption text-subtle">
                    Downloaded
                    <time datetime={new Date(entry.downloadedAt).toISOString()}>
                      {new Date(entry.downloadedAt).toLocaleString()}
                    </time>
                    · {entry.format === "mp3" ? "MP3" : entry.contentType}
                    · {sizeFormatter.format(entry.size / 1_000_000)}
                  </p>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else if !loading && !downloadError && !cache.error}
      <div class="stack-md">
        <h2 class="heading-sm">No downloads yet</h2>
        <p class="body">Download music from your library to listen offline.</p>
        <div class="row-sm">
          <a class="button" data-variant="secondary" data-size="text" href="#/library"
            >Open library</a
          >
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  /* Temporary page placement inside the legacy scrolling shell. The shell
   * migration will own the shared page gutters and height instead. */
  .downloads-view {
    box-sizing: border-box;
    min-block-size: 100%;
    padding: var(--content-padding-block) var(--content-padding-inline);
  }
</style>
