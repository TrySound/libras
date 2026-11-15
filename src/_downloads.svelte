<script lang="ts">
  import Icon from "./icon.svelte";
  import Artwork from "./ui/artwork.svelte";
  import Loader from "./ui/loader.svelte";
  import type { Cache } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Playback } from "./playback.svelte";

  interface Props {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    loading: boolean;
    playback: Playback;
    appName?: string;
  }

  let { cache, covers, trackEngine, playback, loading, appName = "Libras" }: Props = $props();
  let removing = $state(false);
  let removalMessage = $state("");
  const completed = $derived(
    [...cache.downloads].filter(([, entry]) => entry.status === "completed"),
  );
  const savedBytes = $derived(
    completed.reduce((sum, [, entry]) => sum + (entry.status === "completed" ? entry.size : 0), 0),
  );
  async function remove(keys: string[]) {
    if (removing || loading) return;
    removing = true;
    removalMessage = "";
    const workspace = cache;
    playback.unloadDownloadedTrack(
      new Set(
        keys.flatMap((key) => {
          const entry = workspace.downloads.get(key);
          return entry ? [entry.track.id] : [];
        }),
      ),
    );
    try {
      await workspace.removeDownloads(keys);
      if (workspace === cache) removalMessage = "Downloaded music removed. Queue unchanged.";
    } catch {
      if (workspace === cache)
        removalMessage = "Could not remove downloaded music. Please try again.";
    } finally {
      removing = false;
    }
  }

  const canceling = $derived(trackEngine.cancelingDownloads);
  const failed = $derived(
    [...cache.downloads.values()].filter((entry) => entry.status === "failed"),
  );

  const counts = $derived.by(() => {
    const pending = new Set<string>();
    const downloaded = new Set<string>();
    for (const entry of cache.downloads.values()) {
      if (entry.status === "completed") {
        downloaded.add(entry.track.id);
      } else if (entry.status === "queued") {
        pending.add(entry.track.id);
      }
    }
    for (const job of trackEngine.downloadJobs) {
      pending.add(job.track.id);
    }
    return { pending: pending.size, downloaded: downloaded.size };
  });

  function retryAll() {
    if (loading || canceling || !failed.length) return;
    const ids = new Set<string>();
    for (const entry of failed) {
      ids.add(entry.track.id);
    }
    trackEngine.downloadMany(ids);
  }

  async function cancelAll() {
    if (loading || canceling || (!counts.pending && !failed.length)) return;
    try {
      await trackEngine.cancelDownloads();
    } catch {
      // Durable intent and the existing rows remain authoritative on failure.
    }
  }

  const sizeFormatter = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  });
  const downloads = $derived.by(() => {
    const jobs = trackEngine.downloadJobs;
    const activeKeys = new Set(jobs.map((job) => job.key));
    const completed = [...cache.downloads]
      .flatMap(([key, entry]) =>
        entry.status === "completed" && !activeKeys.has(key)
          ? [{ ...entry, key, status: "downloaded" as const }]
          : [],
      )
      .sort((a, b) => b.downloadedAt - a.downloadedAt || a.key.localeCompare(b.key));
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
      <p class="body text-secondary">
        {counts.downloaded}
        {counts.downloaded === 1 ? "track" : "tracks"} downloaded · {sizeFormatter.format(
          savedBytes / 1_000_000,
        )} downloaded audio
      </p>
      <p class="body text-secondary">
        {counts.pending} pending · {failed.length} failed
      </p>
      {#if trackEngine.waitingForConnection && trackEngine.downloadCount}
        <p class="body">Paused while working offline</p>
      {/if}
      <div class="row-sm row-wrap">
        <button
          class="button"
          data-variant="secondary"
          data-size="text"
          disabled={loading || removing || canceling || !failed.length}
          onclick={retryAll}>Retry all</button
        >
        <button
          class="button"
          data-variant="secondary"
          data-size="text"
          disabled={loading || removing || canceling || (!counts.pending && !failed.length)}
          onclick={cancelAll}>{canceling ? "Canceling…" : "Cancel downloads"}</button
        >
        <button
          class="button"
          data-size="text"
          data-variant="secondary"
          disabled={loading || removing || canceling || !completed.length}
          command="show-modal"
          commandfor="remove-downloads"
          >{removing ? "Removing…" : "Remove all downloaded music"}</button
        >
      </div>
      {#if removalMessage}<p class="body" role="status">{removalMessage}</p>{/if}
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
            {#if entry.status === "downloading"}
              <span class="track-row-number row-sm" role="img" aria-label="Downloading">
                <Loader />
              </span>
            {:else if entry.status === "queued"}
              <span class="track-row-number row-sm" role="img" aria-label="Queued for download">
                <Icon name="clock" color="var(--text-subtle)" />
              </span>
            {:else if entry.status === "failed"}
              <span class="track-row-number row-sm" role="img" aria-label="Download failed">
                <Icon name="cross" color="var(--error-text)" />
              </span>
            {:else}
              <span class="track-row-number row-sm" role="img" aria-label="Downloaded">
                <Icon name="check" color="var(--accent)" />
              </span>
            {/if}
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
                  <p class="caption text-secondary">
                    {entry.format === "mp3" ? "MP3" : entry.contentType} · {entry.diagnostic}
                  </p>
                  <button
                    class="button"
                    data-variant="secondary"
                    data-size="text"
                    aria-label={`Retry download of ${entry.track.title} (${entry.format.toUpperCase()})`}
                    disabled={loading || removing || canceling}
                    onclick={() => {
                      void trackEngine.download(entry.track.id, { format: entry.format });
                    }}>Retry</button
                  >
                {:else if entry.status === "downloaded"}
                  <p class="caption text-subtle">
                    Downloaded
                    <time datetime={new Date(entry.downloadedAt).toISOString()}>
                      {new Date(entry.downloadedAt).toLocaleString()}
                    </time>
                    · {entry.format === "mp3" ? "MP3" : entry.contentType}
                    · {sizeFormatter.format(entry.size / 1_000_000)}
                  </p>
                  <button
                    class="button"
                    data-size="text"
                    data-variant="secondary"
                    disabled={loading || removing || canceling}
                    aria-label={`Remove ${entry.track.title} (${entry.format.toUpperCase()})`}
                    onclick={() => void remove([entry.key])}
                    >{removing ? "Removing…" : "Remove"}</button
                  >
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

<dialog
  id="remove-downloads"
  class="dialog"
  closedby="any"
  aria-labelledby="remove-downloads-title"
  aria-describedby="remove-downloads-scope"
>
  <div class="stack-md">
    <h2 class="heading-md" id="remove-downloads-title">Remove all downloaded music?</h2>
    <p class="body" id="remove-downloads-scope">
      Remove {counts.downloaded}
      {counts.downloaded === 1 ? "track" : "tracks"} · {sizeFormatter.format(
        savedBytes / 1_000_000,
      )} downloaded audio from this account on this device. Queue membership and server files stay unchanged.
      Pending downloads are not removed; use Cancel downloads separately.
    </p>
    <div class="row-sm row-wrap row-end">
      <button
        class="button"
        data-size="text"
        command="close"
        commandfor="remove-downloads"
        autofocus>Cancel</button
      >
      <button
        class="button"
        data-size="text"
        data-variant="primary"
        disabled={removing || loading || canceling || !completed.length}
        command="close"
        commandfor="remove-downloads"
        onclick={() => void remove(completed.map(([key]) => key))}>Remove downloaded music</button
      >
    </div>
  </div>
</dialog>
