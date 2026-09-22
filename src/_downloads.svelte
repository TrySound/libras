<script lang="ts">
  import Icon from "./icon.svelte";
  import type { Cache } from "./cache.svelte";
  import type { TrackEngine } from "./track.svelte";

  interface Props {
    cache: Cache;
    trackEngine: TrackEngine;
    loading: boolean;
  }

  let { cache, trackEngine, loading }: Props = $props();

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

<section class="app-page view stack-md">
  <h2 class="type-heading">Downloads</h2>
  <p class="type-small text-muted">
    Downloading first, then queued tracks and saved files, newest first.
  </p>
  {#if loading}
    <p class="type-body text-muted" role="status">Restoring local library…</p>
  {/if}
  {#if downloads.length}
    <div class="wings">
      {#each downloads as entry (entry.key)}
        <div class="wings-item">
          <span
            class="track-leading"
            role="img"
            aria-label={entry.status === "downloading"
              ? "Downloading"
              : entry.status === "queued"
                ? "Queued"
                : "Downloaded"}
          >
            <Icon
              name={entry.status === "downloading"
                ? "loading"
                : entry.status === "queued"
                  ? "clock"
                  : "check"}
            />
          </span>
          <div class="track-details stack-xs">
            <strong class="type-small">{entry.track.title}</strong>
            <p class="type-caption text-muted">
              {entry.track.artist} — {entry.track.album}
            </p>
            {#if entry.status === "downloaded"}
              <p class="type-caption text-muted">
                <time datetime={new Date(entry.downloadedAt).toISOString()}>
                  {new Date(entry.downloadedAt).toLocaleString()}
                </time>
                · {entry.format === "mp3" ? "MP3" : entry.contentType}
              </p>
            {/if}
          </div>
          <span class="type-caption text-muted">
            {entry.status === "downloaded"
              ? new Intl.NumberFormat(undefined, {
                  style: "unit",
                  unit: "megabyte",
                  maximumFractionDigits: 1,
                }).format(entry.size / 1_000_000)
              : entry.status === "downloading"
                ? "Downloading…"
                : "Queued"}
          </span>
        </div>
      {/each}
    </div>
  {:else if !loading}
    <p class="type-body text-muted">No downloaded files yet.</p>
  {/if}
</section>
