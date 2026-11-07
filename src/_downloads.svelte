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
    appName?: string;
  }

  let { cache, covers, trackEngine, loading, appName = "Libras" }: Props = $props();

  const sizeFormatter = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  });
  const downloads = $derived.by(() => {
    const jobs = trackEngine.downloadJobs;
    const activeKeys = new Set(jobs.map((job) => job.key));
    const completed = [...cache.completedDownloads]
      .filter(([key]) => !activeKeys.has(key))
      .sort(([aKey, a], [bKey, b]) => b.downloadedAt - a.downloadedAt || aKey.localeCompare(bKey))
      .map(([key, file]) => ({ ...file, key, status: "downloaded" as const }));
    const failed = [...cache.downloads].flatMap(([key, entry]) =>
      entry.status === "failed" ? [{ ...entry, key, status: "failed" as const }] : [],
    );
    return [...jobs, ...failed, ...completed];
  });
</script>

<svelte:head><title>Downloads | {appName}</title></svelte:head>

<section aria-labelledby="downloads-heading">
  <div class="stack-lg scroll-runway">
    <header class="stack-sm">
      <h1 class="heading-lg uppercase" id="downloads-heading">Downloads</h1>
      <p class="body text-secondary">Tracks available for offline listening.</p>
    </header>

    {#if cache.reportingError}
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
                  : entry.status === "failed"
                    ? "Download failed"
                    : "Downloaded"}
            >
              {#if entry.status === "downloading"}
                <Loader />
              {:else}
                <Icon
                  name={entry.status === "queued"
                    ? "clock"
                    : entry.status === "failed"
                      ? "cross"
                      : "check"}
                  color={entry.status === "queued"
                    ? "var(--text-subtle)"
                    : entry.status === "failed"
                      ? "var(--error-text)"
                      : "var(--accent)"}
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
                <p class="caption text-secondary">{entry.track.artist} · {entry.track.album}</p>
                {#if entry.status === "failed"}
                  <p class="caption text-secondary" aria-live="polite">
                    {entry.format === "mp3" ? "MP3" : entry.contentType} · {entry.diagnostic}
                  </p>
                  <button
                    class="button"
                    data-variant="secondary"
                    data-size="text"
                    aria-label={`Retry download of ${entry.track.title} (${entry.format.toUpperCase()})`}
                    onclick={() => {
                      void trackEngine.retryDownload(entry.track.id, entry.format);
                    }}>Retry</button
                  >
                {:else if entry.status === "queued"}
                  <p class="caption text-subtle">
                    {trackEngine.waitingForConnection ? "Waiting for connection" : "Queued"} · {entry.format.toUpperCase()}
                  </p>
                {:else if entry.status === "downloaded"}
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
    {:else if !loading && !cache.error && !cache.downloadStorageBlocked}
      <div class="stack-md">
        <h2 class="heading-sm">No downloads yet</h2>
        <p class="body">Your saved tracks will appear here.</p>
        <div class="row-sm">
          <a class="button" data-variant="secondary" data-size="text" href="?/library"
            >Open library</a
          >
        </div>
      </div>
    {/if}
  </div>
</section>
