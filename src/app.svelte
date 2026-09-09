<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { installLongPress } from "./long-press";
  import { PlaybackEngine } from "./playback-engine";
  import WebappUpdater from "./webapp-updater.svelte";
  import { AuthStore } from "./auth";
  import { CoverEngine } from "./cover-engine";
  import { MetadataEngine } from "./metadata-engine";
  import { Storage } from "./storage";
  import type {
    Album as AlbumRecord,
    Artist as ArtistRecord,
    Track as TrackRecord,
  } from "./schema";
  import { Memory, type Immutable } from "./memory.svelte";

  type Album = Immutable<AlbumRecord>;
  type Artist = Immutable<ArtistRecord>;
  type Track = Immutable<TrackRecord>;
  import { QueueEngine } from "./queue-engine";
  import { type RouteParams } from "./router-engine";
  import { Session } from "./session.svelte";
  import { Network } from "./network.svelte";
  import Router, { type RouteControls, type RouterNavigate } from "./router.svelte";
  import { TrackEngine } from "./track-engine";
  import { swipeToDismiss } from "./swipe-to-dismiss";

  let updater = $state<ReturnType<typeof WebappUpdater>>();
  const appUpdate = $derived(updater?.getStatus());

  const memory = new Memory();
  const storage = new Storage();
  const metadataEngine = new MetadataEngine(memory, storage);
  const queueEngine = new QueueEngine(memory);
  let navigate = $state<RouterNavigate>(() => {});
  let artists = $derived([...memory.artists.values()]);
  let queue = $derived(
    memory.queueTracks.flatMap((id, index) => {
      const track = memory.tracks.get(id);
      return track && (!offlineMode || trackEngine.getStatus(id) === "downloaded")
        ? [{ track, index }]
        : [];
    }),
  );
  const coverEngine = new CoverEngine(memory, metadataEngine);
  const trackEngine = new TrackEngine({ memory });
  const downloads = $derived.by(() => {
    const jobs = trackEngine.downloadJobs;
    const activeKeys = new Set(jobs.map((job) => job.key));
    const completed = [...memory.downloads.values()]
      .filter((file) => !activeKeys.has(file.key))
      .sort((a, b) => b.downloadedAt - a.downloadedAt || a.key.localeCompare(b.key))
      .map((file) => ({ ...file, status: "downloaded" as const }));
    return [...jobs, ...completed];
  });
  const playback: PlaybackEngine = new PlaybackEngine({
    queue: queueEngine,
    memory,
    tracks: trackEngine,
    covers: coverEngine,
    isAvailable: (id) => !offlineMode || trackEngine.getStatus(id) === "downloaded",
  });
  const network = new Network();
  const session = new Session({
    memory,
    network,
    auth: new AuthStore(),
    metadata: metadataEngine,
    queue: queueEngine,
    covers: coverEngine,
    tracks: trackEngine,
    playback,
    storage: localStorage,
  });
  const libraryAvailable = $derived(metadataEngine.savedAt !== undefined);
  const offlineMode = $derived(session.offlineMode);
  const error = $derived(session.error);
  const refreshError = $derived(session.refreshError);
  let playbackLoading = $derived(["loading", "buffering", "seeking"].includes(playback.status));
  let downloadError = $state("");
  let playbackError = $derived(
    playback.error instanceof Error
      ? playback.error.message
      : playback.error
        ? String(playback.error)
        : "",
  );
  let downloadingCollection = $state("");
  const offlineScanning = $derived(offlineMode && trackEngine.downloadsLoading);
  let loading = $derived(metadataEngine.status === "loading");

  onMount(() => installLongPress());
  onMount(() => playback.mount());

  onDestroy(() => {
    session.destroy();
    playback.destroy();
    coverEngine.destroy();
    metadataEngine.destroy();
    queueEngine.destroy();
    trackEngine.destroy();
  });

  onMount(() => {
    const savedAuth = session.start();
    if (!savedAuth && !memory.account) navigate("/settings", "replace");
  });

  function artistPath(artist: Artist) {
    return `/library/artist/${encodeURIComponent(artist.id)}`;
  }

  function albumPath(artist: Artist, album: Album) {
    return `${artistPath(artist)}/album/${encodeURIComponent(album.id)}`;
  }

  function uniqueGenres(genres: string[]) {
    return [...new Map(genres.map((genre) => [genre.toLocaleLowerCase(), genre])).values()].sort(
      (a, b) => a.localeCompare(b),
    );
  }

  function albumGenres(album: Album) {
    return uniqueGenres([
      ...album.genres,
      ...(memory.albumTracks.get(album.id) ?? []).flatMap((track) => track.genres),
    ]);
  }

  function artistGenres(artist: Artist) {
    return uniqueGenres([
      ...artist.genres,
      ...(memory.artistAlbums.get(artist.id) ?? []).flatMap(albumGenres),
    ]);
  }

  function artistTracks(artist: Artist): readonly Track[] {
    return (memory.artistAlbums.get(artist.id) ?? []).flatMap(
      (album) => memory.albumTracks.get(album.id) ?? [],
    );
  }

  function availableTracks(items: readonly Track[]) {
    return offlineMode
      ? items.filter((track) => trackEngine.getStatus(track.id) === "downloaded")
      : items;
  }

  function playAlbum(album: Album) {
    replaceQueueAndPlay(availableTracks(memory.albumTracks.get(album.id) ?? []));
  }

  function playArtist(artist: Artist) {
    replaceQueueAndPlay(availableTracks(artistTracks(artist)));
  }

  function playNext(tracks: readonly Track[]) {
    const items = availableTracks(tracks);
    if (items.length === 0) return;
    if (memory.queueTracks.length === 0) {
      replaceQueueAndPlay(items);
      return;
    }

    const insertAt = Math.max(0, memory.queueIndex + 1);
    queueEngine.update({
      index: memory.queueIndex,
      position: memory.queuePosition,
      tracks: [
        ...memory.queueTracks.slice(0, insertAt),
        ...items.map((track) => track.id),
        ...memory.queueTracks.slice(insertAt),
      ],
    });
  }

  function playLast(tracks: readonly Track[]) {
    const items = availableTracks(tracks);
    if (items.length === 0) return;
    if (memory.queueTracks.length === 0) {
      replaceQueueAndPlay(items);
      return;
    }

    queueEngine.update({
      index: memory.queueIndex,
      position: memory.queuePosition,
      tracks: [...memory.queueTracks, ...items.map((track) => track.id)],
    });
  }

  function playTrack(track: Track) {
    const albumTracks = availableTracks(memory.albumTracks.get(track.albumId) ?? []);
    const selectedIndex = albumTracks.findIndex((item) => item.id === track.id);
    replaceQueueAndPlay(albumTracks, Math.max(0, selectedIndex));
  }

  async function downloadTrack(track: Track) {
    try {
      const album = memory.albums.get(track.albumId);
      const artwork = memory.trackArtwork.get(track.id) ?? [];
      await trackEngine.cache({
        id: track.id,
        title: track.title,
        artist: memory.artists.get(track.artistId)?.name,
        album: album?.title,
        contentType: track.mimeType,
        coverArt: artwork.find((id) => memory.images.has(id)) ?? artwork[0],
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      downloadError =
        caught instanceof Error ? caught.message : "The track could not be downloaded.";
    }
  }

  async function downloadTracks(items: readonly Track[]) {
    await Promise.all(items.map(downloadTrack));
  }

  async function downloadAlbum(album: Album) {
    const key = `album:${album.id}`;
    downloadingCollection = key;
    try {
      await downloadTracks(memory.albumTracks.get(album.id) ?? []);
    } finally {
      if (downloadingCollection === key) downloadingCollection = "";
    }
  }

  async function downloadArtist(artist: Artist) {
    const key = `artist:${artist.id}`;
    downloadingCollection = key;
    try {
      await downloadTracks(artistTracks(artist));
    } finally {
      if (downloadingCollection === key) downloadingCollection = "";
    }
  }

  function replaceQueueAndPlay(items: readonly Track[], startIndex = 0) {
    if (!items.length) {
      clearQueue();
      return;
    }
    queueEngine.update({ tracks: items.map((track) => track.id), position: 0 });
    void playback.playIndex(Math.max(0, Math.min(startIndex, items.length - 1)));
  }

  function clearQueue() {
    playback.stop();
    queueEngine.update({ tracks: [], position: 0 });
  }

  function playbackPercent() {
    if (!Number.isFinite(playback.duration) || playback.duration <= 0) return 0;
    return Math.min(100, Math.max(0, (memory.queuePosition / playback.duration) * 100));
  }

  function formatTime(value: number) {
    if (!Number.isFinite(value)) return "0:00";
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  let host = $state("");
  let username = $state("");
  let password = $state("");
  const statusLabel = $derived(
    session.busy
      ? "Checking…"
      : !session.auth
        ? "Disconnected"
        : session.offlineMode
          ? "Offline mode"
          : session.status === "error"
            ? "Connection failed"
            : "Connected",
  );

  async function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    if (await session.connect({ host, username, password })) {
      host = username = password = "";
      navigate("/library");
    }
  }

  function disconnectServer() {
    session.disconnect();
    host = username = password = "";
  }
</script>

<svelte:head>
  <title>Libras</title>
</svelte:head>

{#snippet icon(name: string)}
  <svg aria-hidden="true" width="20" height="20">
    <use href={`#icon-${name}`}></use>
  </svg>
{/snippet}

{#snippet brand()}
  <div class="topbar-brand">
    <strong class="type-heading">LIBRAS</strong>
  </div>
{/snippet}

{#snippet settingsRoute(_params: RouteParams, router: RouteControls)}
  <header class="topbar wings">
    <span class="icon-button visually-hidden" aria-hidden="true"></span>
    {@render brand()}
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Home">{@render icon("home")}</a
    >
  </header>
  <section class="view settings-view stack-md">
    <div class="stack-sm">
      <span class="type-eyebrow text-muted">Settings</span>
      <h2 class="type-heading">
        {session.auth ? "Music server" : "Connect to your music"}
      </h2>
      <p class="type-body text-muted">
        {session.auth
          ? "Disconnect first to change servers. Your offline library will stay on this device."
          : "Enter your Navidrome server details. Authentication stays on this device."}
      </p>
    </div>

    <section class="connection-card" aria-label="Music server">
      <div class="connection-card-header">
        <span
          class="connection-dot"
          class:offline={session.offlineMode}
          class:connected={!session.offlineMode && session.status === "connected"}
          class:connecting={session.busy}
          class:failed={session.status === "error"}
        ></span>
        <span class="connection-summary stack-xs">
          <strong class="type-title">
            {session.auth?.host ?? "Add a server"}
          </strong>
          {#if session.auth}
            <small class="type-small text-muted">
              {`${session.auth.username} · ${statusLabel}`}
            </small>
          {/if}
        </span>
        {#if session.auth}
          <div class="connection-actions">
            <button
              class="icon-button"
              data-size="md"
              data-variant="neutral"
              aria-label={session.busy ? "Refreshing…" : "Refresh library"}
              title={session.busy ? "Refreshing…" : "Refresh library"}
              disabled={session.offlineMode || session.busy}
              onclick={() => void session.refresh()}
            >
              {@render icon(session.busy ? "loading" : "refresh")}
            </button>
            <button
              class="icon-button"
              data-size="md"
              data-variant="neutral"
              aria-label="Disconnect"
              title="Disconnect"
              onclick={disconnectServer}
            >
              {@render icon("disconnect")}
            </button>
          </div>
        {/if}
      </div>
      {#if !session.auth || session.error || session.refreshError}
        <div class="connection-details">
          {#if session.error}
            <p class="error type-small" role="alert">{session.error}</p>
          {/if}
          {#if session.refreshError}
            <p class="error type-small" role="status">
              {session.refreshError} Your existing library is still available.
            </p>
          {/if}
          {#if !session.auth}
            <form class="stack-md" onsubmit={submitConnection}>
              <div class="stack-sm">
                <div class="stack-xs">
                  <label for="server-host">Host</label>
                  <input
                    id="server-host"
                    type="text"
                    bind:value={host}
                    placeholder="https://music.example.com"
                    autocomplete="url"
                    required
                    disabled={session.busy}
                  />
                </div>
                <div class="stack-xs">
                  <label for="server-username">Username</label>
                  <input
                    id="server-username"
                    type="text"
                    bind:value={username}
                    autocomplete="username"
                    required
                    disabled={session.busy}
                  />
                </div>
                <div class="stack-xs">
                  <label for="server-password">Password</label>
                  <input
                    id="server-password"
                    type="password"
                    bind:value={password}
                    autocomplete="current-password"
                    required
                    disabled={session.busy}
                  />
                </div>
              </div>
              <button
                class="button"
                type="submit"
                data-size="md"
                data-variant="neutral"
                disabled={session.busy}
              >
                {session.busy ? "Connecting…" : "Connect"}
              </button>
              <small>Authentication is saved in this browser after a successful login.</small>
            </form>
          {/if}
        </div>
      {/if}
    </section>

    {#if appUpdate?.message}
      <section class="settings-option" aria-label="App update">
        <div class="stack-xs">
          <strong class="type-title">App update</strong>
          <small class="type-small text-muted">{appUpdate.message}</small>
        </div>
        {#if appUpdate.hasUpdate}
          <button
            class="button"
            data-size="sm"
            disabled={appUpdate.busy}
            onclick={() => void updater?.update()}
          >
            {appUpdate.busy ? "Updating…" : "Update now"}
          </button>
        {/if}
      </section>
    {/if}

    <div class="settings-option">
      <div class="stack-xs">
        <strong class="type-title">Offline library</strong>
        <small class="type-small text-muted">
          {#if !session.auth}
            Connect to a server to browse online.
          {:else if offlineScanning}
            Reading downloads catalog…
          {:else}
            Show only music downloaded to this device.
          {/if}
          <a class="text-link" href={router.href("/downloads")}>View downloads</a>
        </small>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          aria-label="Offline library"
          checked={session.offlineMode}
          disabled={!session.auth || session.busy || offlineScanning}
          onchange={(event) => void session.setOfflineMode(event.currentTarget.checked)}
        />
      </label>
    </div>
  </section>
  {@render miniPlayer()}
{/snippet}

{#snippet downloadsRoute(_params: RouteParams, router: RouteControls)}
  <header class="topbar wings">
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/settings")}
      title="Settings"
    >
      {@render icon("back")}
    </a>
    {@render brand()}
    <span class="icon-button visually-hidden" aria-hidden="true"></span>
  </header>
  <section class="view stack-md">
    <h2 class="type-heading">Downloads</h2>
    <p class="type-small text-muted">
      Downloading first, then queued tracks and saved files, newest first.
    </p>
    {#if trackEngine.error}
      <p class="error type-small" role="status">
        {trackEngine.error instanceof Error ? trackEngine.error.message : String(trackEngine.error)}
      </p>
    {/if}
    {#if trackEngine.downloadsLoading}
      <p class="type-body text-muted" role="status">Reading downloaded files…</p>
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
              {@render icon(
                entry.status === "downloading"
                  ? "loading"
                  : entry.status === "queued"
                    ? "clock"
                    : "check",
              )}
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
    {:else if !trackEngine.downloadsLoading}
      <p class="type-body text-muted">No downloaded files yet.</p>
    {/if}
  </section>
  {@render miniPlayer()}
{/snippet}

{#snippet alerts()}
  {#if error}
    <p class="error type-small" role="alert">{error}</p>
  {/if}

  {#if refreshError}
    <p class="error type-small">
      {refreshError} Your existing library is still available.
    </p>
  {/if}
{/snippet}

{#snippet playerDialog()}
  {@const artist = playback.track && memory.artists.get(playback.track.artistId)}
  {@const album = playback.track && memory.albums.get(playback.track.albumId)}
  {@const albumArtist = album && memory.artists.get(album.artistId)}
  <dialog id="player-dialog" class="player-dialog" closedby="any" use:swipeToDismiss>
    <header class="topbar wings">
      <button
        class="icon-button"
        data-size="md"
        data-variant="neutral"
        commandfor="player-dialog"
        command="close"
        title="Close player">{@render icon("chevron-down")}</button
      >
      {@render brand()}
      <span class="icon-button visually-hidden" aria-hidden="true"></span>
    </header>
    {@render alerts()}

    <section class="view player-view">
      <div class="player-main">
        <div class="artwork">
          {#if playback.track}
            {@const cover = coverEngine.ensureTrackCover(playback.track.id, {
              allowNetwork: !offlineMode,
            })}
            {#if cover.source}
              <img src={cover.source} alt="" loading="lazy" onload={cover.cache} />
            {:else}
              <span>{@render icon("music")}</span>
            {/if}
          {:else}
            <span>{@render icon("music")}</span>
          {/if}
        </div>

        {#if playback.track}
          <p class="type-body">
            <strong class="type-heading">{playback.track.title}</strong>
            <br />
            {#if artist && album && albumArtist}
              <a
                class="text-link"
                href={`#${artistPath(artist)}`}
                onclick={(event) => event.currentTarget.closest("dialog")?.close()}
              >
                {artist.name}
              </a>
              —
              <a
                class="text-link"
                href={`#${albumPath(albumArtist, album)}`}
                onclick={(event) => event.currentTarget.closest("dialog")?.close()}
              >
                {album.title}
              </a>
            {:else}
              {artist?.name} — {album?.title}
            {/if}
          </p>
        {/if}

        <div class="playback-progress">
          <input
            class="playback-slider"
            type="range"
            min="0"
            max={Number.isFinite(playback.duration) ? playback.duration : 0}
            step="0.1"
            value={memory.queuePosition}
            disabled={!playback.duration ||
              (offlineMode &&
                playback.track &&
                trackEngine.getStatus(playback.track.id) !== "downloaded")}
            oninput={(event) => playback.seek(event.currentTarget.valueAsNumber)}
          />
          <div class="playback-time type-caption">
            <span>{formatTime(memory.queuePosition)}</span>
            <span>{formatTime(playback.duration)}</span>
          </div>
        </div>

        <div class="controls">
          <button
            class="icon-button"
            data-size="md"
            data-variant="neutral"
            onclick={() => playback.previous()}
            disabled={!playback.hasPrevious && memory.queuePosition <= 0}
            title="Previous">{@render icon("previous")}</button
          >
          <button
            class="icon-button"
            data-size="lg"
            data-variant="primary"
            onclick={() => playback.toggle()}
            disabled={queue.length === 0}
            title={playback.playing ? "Pause" : "Play"}
          >
            {#if playbackLoading}
              {@render icon("loading")}
            {:else if playback.playing}
              {@render icon("pause")}
            {:else}
              {@render icon("play")}
            {/if}
          </button>
          <button
            class="icon-button"
            data-size="md"
            data-variant="neutral"
            onclick={() => playback.next()}
            disabled={!playback.hasNext}
            title="Next">{@render icon("next")}</button
          >
        </div>

        {#if downloadError}
          <p class="error type-small">{downloadError}</p>
        {/if}
        {#if playbackError}
          <p class="error type-small">{playbackError}</p>
        {/if}
        {#if queueEngine.storageError}
          <p class="error type-small" role="status">
            Queue could not be saved or restored locally: {queueEngine.storageError instanceof Error
              ? queueEngine.storageError.message
              : String(queueEngine.storageError)}.
          </p>
        {/if}
        {#if queueEngine.error}
          <p class="error type-small" role="status">
            Queue synchronization failed: {queueEngine.error instanceof Error
              ? queueEngine.error.message
              : String(queueEngine.error)}. Local playback is unaffected.
          </p>
        {/if}
      </div>

      <div class="player-queue">
        <div class="section-heading">
          <div>
            <span class="type-eyebrow text-muted">Up next</span>
            <h2 class="type-heading">
              {queue.length} track{queue.length === 1 ? "" : "s"}
            </h2>
          </div>
          {#if memory.queueTracks.length > 0}
            <button class="button" data-size="sm" data-variant="neutral" onclick={clearQueue}
              >Clear</button
            >
          {/if}
        </div>
        {#if queue.length > 0}
          <div class="wings">
            {#each queue as { track, index }, visibleIndex}
              {@const downloadStatus = trackEngine.getStatus(track.id)}
              <div class="wings-item row-button">
                <button
                  class="linkarea"
                  aria-label={`Play ${track.title}`}
                  onclick={() => playback.playIndex(index)}
                ></button>
                <span class="track-leading">
                  {#if index === memory.queueIndex && playbackLoading}
                    <span role="img" aria-label="Loading playback">
                      {@render icon("loading")}
                    </span>
                  {:else if index === memory.queueIndex && playback.playing}
                    <span role="img" aria-label="Playing">
                      {@render icon("sound-bars")}
                    </span>
                  {:else if index === memory.queueIndex}
                    <span role="img" aria-label="Current track, not playing">
                      {@render icon("pause")}
                    </span>
                  {:else if downloadStatus === "downloading"}
                    <span role="img" aria-label="Downloading">
                      {@render icon("loading")}
                    </span>
                  {:else if downloadStatus === "queued"}
                    <span role="img" aria-label="Queued for download">
                      {@render icon("clock")}
                    </span>
                  {:else}
                    {visibleIndex + 1}
                  {/if}
                </span>
                <span>{track.title}</span>
              </div>
            {/each}
          </div>
        {:else if memory.queueTracks.length > 0}
          <p class="type-body text-muted">No available tracks.</p>
        {:else}
          <p class="type-body text-muted">The queue is empty.</p>
        {/if}
      </div>
    </section>
  </dialog>
{/snippet}

{#snippet libraryRoute(_params: RouteParams, router: RouteControls)}
  {@const visibleArtists = offlineMode
    ? artists.filter((artist) =>
        artistTracks(artist).some((track) => trackEngine.getStatus(track.id) === "downloaded"),
      )
    : artists}

  <header class="topbar wings">
    <span class="icon-button visually-hidden" aria-hidden="true"></span>
    {@render brand()}
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/settings")}
      aria-label={appUpdate?.hasUpdate ? "Settings — app update available" : "Settings"}
      title={appUpdate?.hasUpdate ? "Settings — app update available" : "Settings"}
    >
      {@render icon("settings")}
      {#if appUpdate?.hasUpdate}
        <span class="icon-button-notification" aria-hidden="true"></span>
      {/if}
    </a>
  </header>
  {@render alerts()}

  <section class="view library-view">
    {#if libraryAvailable}
      <div class="section-heading">
        <div>
          <span class="type-eyebrow text-muted">
            {offlineMode ? "Downloaded music" : "Your music"}
          </span>
          <h2 class="type-heading">{visibleArtists.length} artists</h2>
        </div>
      </div>

      {#if offlineScanning}
        <div class="empty-state">
          <div class="scan-spinner">{@render icon("loading")}</div>
          <p class="type-body">Checking downloaded music…</p>
        </div>
      {:else if visibleArtists.length > 0}
        <div class="artist-grid">
          {#each visibleArtists as artist, index}
            {@const menuId = `artist-menu-${index}`}
            {@const cover = coverEngine.ensureArtistCover(artist.id, {
              allowNetwork: !offlineMode,
            })}
            <article class="artist-card">
              <a
                class="artist-main"
                href={router.href(artistPath(artist))}
                data-longpressfor={menuId}
                data-longpress="show-modal"
                title={`${artist.name} — hold for actions`}
              >
                <span class="cover artist-cover">
                  {#if cover.source}
                    <img src={cover.source} alt="" loading="lazy" onload={cover.cache} />
                  {:else}
                    <span>{@render icon("music")}</span>
                  {/if}
                  <strong class="artist-name type-small">{artist.name}</strong>
                </span>
              </a>
              <button
                class="icon-button artist-menu-trigger"
                hidden
                data-size="sm"
                data-variant="overlay"
                commandfor={menuId}
                command="show-modal"
                title={`Open menu for ${artist.name}`}
              >
                {@render icon("menu")}
              </button>
            </article>
          {/each}
        </div>
      {:else}
        <div class="empty-state">
          <span>{@render icon("music")}</span>
          <p class="type-body">
            {offlineMode ? "No downloaded artists." : "No artists found."}
          </p>
        </div>
      {/if}
    {:else if !loading}
      {@render connectLibrary(router)}
    {/if}
  </section>
  {#if libraryAvailable && !offlineScanning}
    {#each visibleArtists as artist, index}
      {@const menuId = `artist-menu-${index}`}
      <dialog
        id={menuId}
        class="action-menu"
        aria-labelledby={`${menuId}-title`}
        closedby="closerequest"
        use:swipeToDismiss
        onclick={(event) => event.currentTarget.close()}
      >
        <div class="stack-sm">
          <header id={`${menuId}-title`} class="type-title">
            {artist.name}
          </header>
          <div class="wings">
            <button class="wings-item row-button" onclick={() => playArtist(artist)}>
              {@render icon("play")}
              <span>Play</span>
            </button>
            <button class="wings-item row-button" onclick={() => playNext(artistTracks(artist))}>
              {@render icon("next")}
              <span>Play next</span>
            </button>
            <button class="wings-item row-button" onclick={() => playLast(artistTracks(artist))}>
              {@render icon("plus")}
              <span>Play last</span>
            </button>
            <button class="wings-item row-button" onclick={() => downloadArtist(artist)}>
              {@render icon("download")}
              <span>Download</span>
            </button>
            <button class="wings-item row-button"><span></span>Cancel</button>
          </div>
        </div>
      </dialog>
    {/each}
  {/if}
  {@render miniPlayer()}
{/snippet}

{#snippet artistRoute(params: RouteParams, router: RouteControls)}
  {@const artist = params.artistId ? memory.artists.get(params.artistId) : undefined}
  {@const visibleAlbums = artist
    ? offlineMode
      ? (memory.artistAlbums.get(artist.id) ?? []).filter((album) =>
          (memory.albumTracks.get(album.id) ?? []).some(
            (track) => trackEngine.getStatus(track.id) === "downloaded",
          ),
        )
      : (memory.artistAlbums.get(artist.id) ?? [])
    : []}

  <header class="topbar wings">
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Back">{@render icon("back")}</a
    >
    {@render brand()}
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Home">{@render icon("home")}</a
    >
  </header>
  {@render alerts()}

  <section class="view collection-view">
    {#if libraryAvailable && artist}
      {@const artwork = coverEngine.ensureArtistCover(artist.id, {
        allowNetwork: !offlineMode,
      })}
      <div class="artwork" aria-hidden="true">
        {#if artwork.source}
          <img src={artwork.source} alt="" onload={artwork.cache} />
        {:else}
          {@render icon("music")}
        {/if}
      </div>
      <div class="section-heading collection-heading">
        <div>
          <span class="type-eyebrow text-muted">Albums</span>
          <h2 class="type-heading">{artist.name}</h2>
          <p class="library-meta type-small">
            {visibleAlbums.length} album{visibleAlbums.length === 1 ? "" : "s"}
          </p>
          {#if artistGenres(artist).length > 0}
            <div class="genre-list">
              {#each artistGenres(artist) as genre}
                <span class="type-caption">
                  {genre}
                </span>
              {/each}
            </div>
          {/if}
        </div>
        <button
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          commandfor="artist-page-menu"
          command="show-modal"
          title={`Open menu for ${artist.name}`}
        >
          {@render icon("menu")}
        </button>
      </div>

      {#if offlineScanning}
        <div class="empty-state">
          <div class="scan-spinner">{@render icon("loading")}</div>
          <p class="type-body">Checking downloaded music…</p>
        </div>
      {:else}
        <div class="wings">
          {#each visibleAlbums as album, index}
            {@const albumMenuId = `album-menu-${index}`}
            {@const visibleTracks = offlineMode
              ? (memory.albumTracks.get(album.id) ?? []).filter(
                  (track) => trackEngine.getStatus(track.id) === "downloaded",
                )
              : (memory.albumTracks.get(album.id) ?? [])}
            {@const cover = coverEngine.ensureAlbumCover(album.id, {
              allowNetwork: !offlineMode,
            })}
            <article class="wings-item row-button">
              <a
                class="linkarea"
                href={router.href(albumPath(artist, album))}
                aria-label={`Open ${album.title}`}
                data-longpressfor={albumMenuId}
                data-longpress="show-modal"
                title={`${album.title} — hold for actions`}
              ></a>
              <span class="track-leading">
                <span class="cover album-cover">
                  {#if cover.source}
                    <img src={cover.source} alt="" loading="lazy" onload={cover.cache} />
                  {:else}
                    <span>{@render icon("music")}</span>
                  {/if}
                </span>
              </span>
              <span class="stack-xs">
                <strong class="type-title">{album.title}</strong>
                <small class="type-small text-muted">
                  {album.year ?? "Unknown year"} · {visibleTracks.length} tracks
                </small>
              </span>
              <span class="track-actions">
                <button
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  commandfor={albumMenuId}
                  command="show-modal"
                  title={`Open menu for ${album.title}`}
                >
                  {@render icon("menu")}
                </button>
              </span>
            </article>
          {:else}
            <div class="empty-state">
              <p class="type-body">
                {offlineMode ? "No downloaded albums." : "No albums found."}
              </p>
            </div>
          {/each}
        </div>
      {/if}
    {:else if !loading}
      <div class="empty-state">
        <span>{@render icon("music")}</span>
        <p class="type-body">
          {libraryAvailable ? "Artist not found." : "Connect your library."}
        </p>
        <a
          class="button"
          data-size="md"
          data-variant="neutral"
          href={router.href(libraryAvailable ? "/library" : "/settings")}
        >
          {libraryAvailable ? "Open library" : "Open settings"}
        </a>
      </div>
    {/if}
  </section>
  {#if libraryAvailable && artist}
    <dialog
      id="artist-page-menu"
      class="action-menu"
      aria-labelledby="artist-page-menu-title"
      closedby="closerequest"
      use:swipeToDismiss
      onclick={(event) => event.currentTarget.close()}
    >
      <div class="stack-sm">
        <header id="artist-page-menu-title" class="type-title">
          {artist.name}
        </header>
        <div class="wings">
          <button class="wings-item row-button" onclick={() => playArtist(artist)}>
            {@render icon("play")}
            <span>Play</span>
          </button>
          <button class="wings-item row-button" onclick={() => playNext(artistTracks(artist))}>
            {@render icon("next")}
            <span>Play next</span>
          </button>
          <button class="wings-item row-button" onclick={() => playLast(artistTracks(artist))}>
            {@render icon("plus")}
            <span>Play last</span>
          </button>
          <button class="wings-item row-button" onclick={() => downloadArtist(artist)}>
            {@render icon("download")}
            <span>Download</span>
          </button>
          <button class="wings-item row-button"><span></span>Cancel</button>
        </div>
      </div>
    </dialog>
    {#if !offlineScanning}
      {#each visibleAlbums as album, index}
        {@const albumMenuId = `album-menu-${index}`}
        <dialog
          id={albumMenuId}
          class="action-menu"
          aria-labelledby={`${albumMenuId}-title`}
          closedby="closerequest"
          use:swipeToDismiss
          onclick={(event) => event.currentTarget.close()}
        >
          <div class="stack-sm">
            <header id={`${albumMenuId}-title`} class="type-title">
              {album.title}
            </header>
            <div class="wings">
              <button class="wings-item row-button" onclick={() => playAlbum(album)}>
                {@render icon("play")}
                <span>Play</span>
              </button>
              <button
                class="wings-item row-button"
                onclick={() => playNext(memory.albumTracks.get(album.id) ?? [])}
              >
                {@render icon("next")}
                <span>Play next</span>
              </button>
              <button
                class="wings-item row-button"
                onclick={() => playLast(memory.albumTracks.get(album.id) ?? [])}
              >
                {@render icon("plus")}
                <span>Play last</span>
              </button>
              <button class="wings-item row-button" onclick={() => downloadAlbum(album)}>
                {@render icon("download")}
                <span>Download</span>
              </button>
              <button class="wings-item row-button"><span></span>Cancel</button>
            </div>
          </div>
        </dialog>
      {/each}
    {/if}
  {/if}
  {@render miniPlayer()}
{/snippet}

{#snippet albumRoute(params: RouteParams, router: RouteControls)}
  {@const artist = params.artistId ? memory.artists.get(params.artistId) : undefined}
  {@const album = params.albumId ? memory.albums.get(params.albumId) : undefined}
  {@const visibleTracks = album
    ? offlineMode
      ? (memory.albumTracks.get(album.id) ?? []).filter(
          (track) => trackEngine.getStatus(track.id) === "downloaded",
        )
      : (memory.albumTracks.get(album.id) ?? [])
    : []}

  <header class="topbar wings">
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={artist ? router.href(artistPath(artist)) : router.href("/library")}
      title="Back">{@render icon("back")}</a
    >
    {@render brand()}
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Home">{@render icon("home")}</a
    >
  </header>
  {@render alerts()}

  <section class="view collection-view">
    {#if libraryAvailable && artist && album}
      {@const artwork = coverEngine.ensureAlbumCover(album.id, {
        allowNetwork: !offlineMode,
      })}
      <div class="artwork" aria-hidden="true">
        {#if artwork.source}
          <img src={artwork.source} alt="" onload={artwork.cache} />
        {:else}
          {@render icon("music")}
        {/if}
      </div>
      <div class="section-heading collection-heading">
        <div>
          <a class="text-link type-eyebrow text-muted" href={router.href(artistPath(artist))}
            >{artist.name}</a
          >
          <h2 class="type-heading">{album.title}</h2>
          <p class="library-meta type-small">
            {album.year ?? "Unknown year"} · {visibleTracks.length}
            track{visibleTracks.length === 1 ? "" : "s"}
          </p>
          {#if albumGenres(album).length > 0}
            <div class="genre-list">
              {#each albumGenres(album) as genre}
                <span class="type-caption">
                  {genre}
                </span>
              {/each}
            </div>
          {/if}
        </div>
        <button
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          commandfor="album-page-menu"
          command="show-modal"
          title={`Open menu for ${album.title}`}
        >
          {@render icon("menu")}
        </button>
      </div>

      {#if offlineScanning}
        <div class="empty-state">
          <div class="scan-spinner">{@render icon("loading")}</div>
          <p class="type-body">Checking downloaded music…</p>
        </div>
      {:else}
        <div class="wings">
          {#each visibleTracks as track, index}
            {@const trackMenuId = `album-track-menu-${index}`}
            {@const downloadStatus = trackEngine.getStatus(track.id)}
            <div class="wings-item row-button">
              <button
                class="linkarea"
                aria-label={`Play ${track.title}`}
                onclick={() => playTrack(track)}
                data-longpressfor={trackMenuId}
                data-longpress="show-modal"
                title={`${track.title} — hold for actions`}
              ></button>
              <span class="track-leading">
                {#if playback.track?.id === track.id && playbackLoading}
                  <span role="img" aria-label="Loading playback">
                    {@render icon("loading")}
                  </span>
                {:else if playback.track?.id === track.id && playback.playing}
                  <span role="img" aria-label="Playing">
                    {@render icon("sound-bars")}
                  </span>
                {:else if playback.track?.id === track.id}
                  <span role="img" aria-label="Current track, not playing">
                    {@render icon("pause")}
                  </span>
                {:else if downloadStatus === "downloading"}
                  <span role="img" aria-label="Downloading">
                    {@render icon("loading")}
                  </span>
                {:else if downloadStatus === "queued"}
                  <span role="img" aria-label="Queued for download">
                    {@render icon("clock")}
                  </span>
                {:else}
                  {track.number ?? index + 1}
                {/if}
              </span>
              <span>{track.title}</span>
              <span class="track-actions">
                <button
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  commandfor={trackMenuId}
                  command="show-modal"
                  title={`Open menu for ${track.title}`}
                >
                  {@render icon("menu")}
                </button>
              </span>
            </div>
          {:else}
            <div class="empty-state">
              <p class="type-body">
                {offlineMode ? "No downloaded tracks." : "No tracks found."}
              </p>
            </div>
          {/each}
        </div>
      {/if}
    {:else if !loading}
      <div class="empty-state">
        <span>{@render icon("music")}</span>
        <p class="type-body">
          {libraryAvailable ? "Album not found." : "Connect your library."}
        </p>
        <a
          class="button"
          data-size="md"
          data-variant="neutral"
          href={router.href(libraryAvailable ? "/library" : "/settings")}
        >
          {libraryAvailable ? "Open library" : "Open settings"}
        </a>
      </div>
    {/if}
  </section>
  {#if libraryAvailable && artist && album}
    <dialog
      id="album-page-menu"
      class="action-menu"
      aria-labelledby="album-page-menu-title"
      closedby="closerequest"
      use:swipeToDismiss
      onclick={(event) => event.currentTarget.close()}
    >
      <div class="stack-sm">
        <header id="album-page-menu-title" class="type-title">
          {album.title}
        </header>
        <div class="wings">
          <button class="wings-item row-button" onclick={() => playAlbum(album)}>
            {@render icon("play")}
            <span>Play</span>
          </button>
          <button
            class="wings-item row-button"
            onclick={() => playNext(memory.albumTracks.get(album.id) ?? [])}
          >
            {@render icon("next")}
            <span>Play next</span>
          </button>
          <button
            class="wings-item row-button"
            onclick={() => playLast(memory.albumTracks.get(album.id) ?? [])}
          >
            {@render icon("plus")}
            <span>Play last</span>
          </button>
          <button class="wings-item row-button" onclick={() => downloadAlbum(album)}>
            {@render icon("download")}
            <span>Download</span>
          </button>
          <button class="wings-item row-button"><span></span>Cancel</button>
        </div>
      </div>
    </dialog>
    {#if !offlineScanning}
      {#each visibleTracks as track, index}
        {@const trackMenuId = `album-track-menu-${index}`}
        {@const downloadStatus = trackEngine.getStatus(track.id)}
        <dialog
          id={trackMenuId}
          class="action-menu"
          aria-labelledby={`${trackMenuId}-title`}
          closedby="closerequest"
          use:swipeToDismiss
          onclick={(event) => event.currentTarget.close()}
        >
          <div class="stack-sm">
            <header id={`${trackMenuId}-title`} class="type-title">
              {track.title}
            </header>
            <div class="wings">
              <button class="wings-item row-button" onclick={() => playTrack(track)}>
                {@render icon("play")}
                <span>Play</span>
              </button>
              <button class="wings-item row-button" onclick={() => playNext([track])}>
                {@render icon("next")}
                <span>Play next</span>
              </button>
              <button class="wings-item row-button" onclick={() => playLast([track])}>
                {@render icon("plus")}
                <span>Play last</span>
              </button>
              <button
                class="wings-item row-button"
                disabled={downloadStatus !== "idle"}
                onclick={() => downloadTrack(track)}
              >
                {#if downloadStatus === "downloaded"}
                  {@render icon("check")}
                  <span>Downloaded</span>
                {:else if downloadStatus === "queued"}
                  {@render icon("clock")}
                  <span>Queued</span>
                {:else if downloadStatus === "downloading"}
                  {@render icon("loading")}
                  <span>Downloading…</span>
                {:else}
                  {@render icon("download")}
                  <span>Download</span>
                {/if}
              </button>
              <button class="wings-item row-button"><span></span>Cancel</button>
            </div>
          </div>
        </dialog>
      {/each}
    {/if}
  {/if}
  {@render miniPlayer()}
{/snippet}

{#snippet connectLibrary(router: RouteControls)}
  <div class="empty-state">
    <span>{@render icon("music")}</span>
    <h2 class="type-heading">Connect your library</h2>
    <p class="type-body">Add your Navidrome server to start listening.</p>
    <a class="button" data-size="md" data-variant="neutral" href={router.href("/settings")}
      >Open settings</a
    >
  </div>
{/snippet}

{#snippet miniPlayer()}
  {#if playback.track}
    {@const cover = coverEngine.ensureTrackCover(playback.track.id, {
      allowNetwork: !offlineMode,
    })}
    <div class="mini-player wings">
      <button
        class="linkarea"
        commandfor="player-dialog"
        command="show-modal"
        aria-label="Open player"
      ></button>
      <span class="mini-art">
        {#if cover.source}
          <img src={cover.source} alt="" loading="lazy" onload={cover.cache} />
        {:else}
          <span>{@render icon("music")}</span>
        {/if}
      </span>
      <span class="mini-copy stack-xs">
        <strong class="type-title">
          {playback.track.title}
        </strong>
        <small class="type-small text-muted">
          {memory.artists.get(playback.track.artistId)?.name}
        </small>
      </span>
      <button
        class="icon-button"
        data-size="md"
        data-variant="primary"
        onclick={() => playback.toggle()}
        title={playback.playing ? "Pause" : "Play"}
      >
        {#if playbackLoading}
          {@render icon("loading")}
        {:else if playback.playing}
          {@render icon("pause")}
        {:else}
          {@render icon("play")}
        {/if}
      </button>
      <span class="mini-progress">
        <span style:width={`${playbackPercent()}%`}></span>
      </span>
    </div>
  {/if}
{/snippet}

<main class="app-shell">
  <Router
    routes={[
      { pattern: "/library", render: libraryRoute },
      {
        pattern: "/library/artist/:artistId/album/:albumId",
        render: albumRoute,
      },
      { pattern: "/library/artist/:artistId", render: artistRoute },
      { pattern: "/settings", render: settingsRoute },
      { pattern: "/downloads", render: downloadsRoute },
    ]}
    bind:navigate
  />

  {@render playerDialog()}
</main>

<WebappUpdater bind:this={updater} />
