<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { installLongPress } from "./long-press";
  import { PlaybackEngine } from "./playback-engine";
  import WebappUpdater from "./webapp-updater.svelte";
  import { AuthStore } from "./auth";
  import { CoverEngine } from "./cover-engine";
  import {
    MetadataEngine,
    type Album,
    type Artist,
    type Track,
  } from "./metadata-engine";
  import { QueueEngine } from "./queue-engine";
  import { type RouteParams } from "./router-engine";
  import { SubsonicClient, type SubsonicAuth } from "./subsonic-client";
  import Router, {
    type RouteControls,
    type RouterNavigate,
  } from "./router.svelte";
  import { TrackEngine } from "./track-engine";
  import { swipeToDismiss } from "./swipe-to-dismiss";

  const offlineModeStorageKey = "navidrome-offline-mode";
  const authStore = new AuthStore();

  type SavedAuth = SubsonicAuth;

  type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

  let host = $state("");
  let username = $state("");
  let password = $state("");
  const metadataEngine = new MetadataEngine();
  const queueEngine = new QueueEngine();
  let navigate = $state<RouterNavigate>(() => {});
  let artists = $derived(metadataEngine.getArtists());
  let queue = $derived(queueEngine.tracks.map((id) => metadataEngine.getTrack(id)).filter((track) => track !== undefined));
  let activeAuth = $state<SavedAuth | null>(null);
  let activeClient = $state<SubsonicClient>();
  const coverEngine = new CoverEngine(metadataEngine);
  const trackEngine = new TrackEngine();
  const playback = new PlaybackEngine({
    queue: queueEngine,
    metadata: metadataEngine,
    tracks: trackEngine,
    covers: coverEngine,
  });
  let playbackLoading = $derived(
    ["loading", "buffering", "seeking"].includes(playback.status),
  );
  let downloadError = $state("");
  let playbackError = $derived(
    playback.error instanceof Error
      ? playback.error.message
      : playback.error
        ? String(playback.error)
        : "",
  );
  let downloadingCollection = $state("");
  let offlineMode = $state(false);
  const offlineScanning = $derived(offlineMode && trackEngine.downloadsLoading);
  let loading = $derived(metadataEngine.status === "loading");
  let refreshing = $derived(metadataEngine.status === "refreshing");
  let refreshError = $state("");
  let error = $state("");
  let connectionStatus = $state<ConnectionStatus>("disconnected");
  let connectionOpen = $state(false);
  let pendingConnection = $state<{ auth: SavedAuth; client: SubsonicClient }>();
  let navigateAfterConnection = $state(false);

  onMount(() => installLongPress());
  onMount(() => playback.mount());

  onDestroy(() => {
    playback.destroy();
    coverEngine.destroy();
    metadataEngine.destroy();
    queueEngine.destroy();
    trackEngine.destroy();
  });

  onMount(() => {
    const lifetime = new AbortController();
    offlineMode = localStorage.getItem(offlineModeStorageKey) === "true";

    try {
      const savedAuth = authStore.load();
      if (!savedAuth) {
        connectionOpen = true;
        navigate("/settings", "replace");
        return;
      }

      activeAuth = savedAuth;
      host = savedAuth.host;
      username = savedAuth.username;
      const account = { host: savedAuth.host, username: savedAuth.username };
      void Promise.all([metadataEngine.restore(account), coverEngine.restore(account)]).then(async () => {
        await coverEngine.refresh();
        if (metadataEngine.snapshot) await queueEngine.restore(account);
        if (!lifetime.signal.aborted) loadArtists(savedAuth);
      });
    } catch {
      authStore.clear();
      connectionOpen = true;
      navigate("/settings", "replace");
    }
    return () => lifetime.abort();
  });

  function artistPath(artist: Artist) {
    return `/library/artist/${encodeURIComponent(artist.id)}`;
  }

  function albumPath(artist: Artist, album: Album) {
    return `${artistPath(artist)}/album/${encodeURIComponent(album.id)}`;
  }

  function uniqueGenres(genres: string[]) {
    return [
      ...new Map(
        genres.map((genre) => [genre.toLocaleLowerCase(), genre]),
      ).values(),
    ].sort((a, b) => a.localeCompare(b));
  }

  function albumGenres(album: Album) {
    return uniqueGenres([
      ...album.genres,
      ...metadataEngine.getAlbumTracks(album.id).flatMap((track) => track.genres),
    ]);
  }

  function artistGenres(artist: Artist) {
    return uniqueGenres([
      ...artist.genres,
      ...metadataEngine.getArtistAlbums(artist.id).flatMap(albumGenres),
    ]);
  }

  function artistTracks(artist: Artist): readonly Track[] {
    return metadataEngine.getArtistAlbums(artist.id).flatMap((album) => metadataEngine.getAlbumTracks(album.id));
  }

  function availableTracks(items: readonly Track[]) {
    return offlineMode
      ? items.filter(
          (track) => trackEngine.getStatus(track.id) === "downloaded",
        )
      : items;
  }

  function playAlbum(album: Album) {
    replaceQueueAndPlay(availableTracks(metadataEngine.getAlbumTracks(album.id)));
  }

  function playArtist(artist: Artist) {
    replaceQueueAndPlay(availableTracks(artistTracks(artist)));
  }

  function playNext(tracks: readonly Track[]) {
    const items = availableTracks(tracks);
    if (items.length === 0) return;
    if (queue.length === 0) {
      replaceQueueAndPlay(items);
      return;
    }

    const insertAt = Math.max(0, playback.currentIndex + 1);
    queueEngine.update({
      index: queueEngine.index,
      position: playback.position,
      tracks: [...queueEngine.tracks.slice(0, insertAt), ...items.map((track) => track.id), ...queueEngine.tracks.slice(insertAt)],
    });
  }

  function playLast(tracks: readonly Track[]) {
    const items = availableTracks(tracks);
    if (items.length === 0) return;
    if (queue.length === 0) {
      replaceQueueAndPlay(items);
      return;
    }

    queueEngine.update({
      index: queueEngine.index,
      position: playback.position,
      tracks: [...queueEngine.tracks, ...items.map((track) => track.id)],
    });
  }

  function playTrack(track: Track) {
    const albumTracks = availableTracks(metadataEngine.getAlbumTracks(track.albumId));
    const selectedIndex = albumTracks.findIndex((item) => item.id === track.id);
    replaceQueueAndPlay(albumTracks, Math.max(0, selectedIndex));
  }

  async function downloadTrack(track: Track) {
    try {
      const album = metadataEngine.getAlbum(track.albumId);
      await trackEngine.cache({
        id: track.id,
        title: track.title,
        artist: metadataEngine.getArtist(track.artistId)?.name,
        album: album?.title,
        contentType: track.mimeType,
        coverArt: coverEngine.getTrackCover(track.id, { allowNetwork: false }).artworkId,
      });
    } catch (caught) {
      downloadError =
        caught instanceof Error
          ? caught.message
          : "The track could not be downloaded.";
    }
  }

  async function downloadTracks(items: readonly Track[]) {
    await Promise.all(items.map(downloadTrack));
  }

  async function downloadAlbum(album: Album) {
    const key = `album:${album.id}`;
    downloadingCollection = key;
    try {
      await downloadTracks(metadataEngine.getAlbumTracks(album.id));
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

  async function applyOfflineLibrary() {
    await trackEngine.ready();
    if (!activeAuth || !offlineMode) return;

    const currentTrackId = playback.track?.id;
    const offlineQueue = queue.filter(
      (track) => trackEngine.getStatus(track.id) === "downloaded",
    );
    if (offlineQueue.length === queue.length) return;
    const offlineIndex = currentTrackId && trackEngine.getStatus(currentTrackId) === "downloaded"
      ? queue.slice(0, playback.currentIndex).filter((track) => trackEngine.getStatus(track.id) === "downloaded").length
      : -1;

    if (currentTrackId && offlineIndex < 0) playback.stop();
    queueEngine.update({
      index: offlineIndex,
      position: offlineIndex >= 0 ? playback.position : 0,
      tracks: offlineQueue.map((track) => track.id),
    });
  }

  async function setOfflineMode(enabled: boolean) {
    offlineMode = enabled;
    localStorage.setItem(offlineModeStorageKey, String(enabled));

    const network = enabled ? "offline" : "online";
    const refresh = metadataEngine.setNetwork(network);
    queueEngine.setNetwork(network);
    if (enabled) await applyOfflineLibrary();
    else if (activeAuth) loadArtists(activeAuth);
    await refresh;
    await coverEngine.refresh();
  }

  function collectionIsDownloaded(items: readonly Track[]) {
    return (
      items.length > 0 &&
      items.every((track) => trackEngine.getStatus(track.id) === "downloaded")
    );
  }

  function replaceQueueAndPlay(items: readonly Track[], startIndex = 0) {
    if (!items.length) {
      clearQueue();
      return;
    }
    queueEngine.update({ tracks: items.map((track) => track.id), position: 0 });
    void playback.playIndex(
      Math.max(0, Math.min(startIndex, items.length - 1)),
    );
  }

  function clearQueue() {
    playback.stop();
    queueEngine.update({ tracks: [], position: 0 });
  }

  function playbackPercent() {
    if (!Number.isFinite(playback.duration) || playback.duration <= 0) return 0;
    return Math.min(100, Math.max(0, (playback.position / playback.duration) * 100));
  }

  function formatTime(value: number) {
    if (!Number.isFinite(value)) return "0:00";
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function connectionStatusLabel() {
    if (offlineMode) return "Offline mode";
    if (connectionStatus === "connected") return "Connected";
    if (connectionStatus === "connecting") return "Checking…";
    if (connectionStatus === "error") return "Connection failed";
    return "Disconnected";
  }

  function connectionError(caught: unknown) {
    if (caught instanceof TypeError) {
      return "Could not reach the server. Check the host and its CORS settings.";
    }
    return caught instanceof Error ? caught.message : "Could not load artists.";
  }

  function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    navigateAfterConnection = true;
    loadArtists();
  }

  async function loadArtists(savedAuth?: SavedAuth, forceRefresh = false) {
    connectionStatus = "connecting";
    error = "";
    refreshError = "";

    try {
      const credentials =
        savedAuth ?? authStore.create({ host, username, password });
      const client =
        activeAuth &&
        activeClient &&
        activeAuth.host === credentials.host &&
        activeAuth.username === credentials.username &&
        activeAuth.token === credentials.token &&
        activeAuth.salt === credentials.salt
          ? activeClient
          : new SubsonicClient(credentials);

      pendingConnection = { auth: credentials, client };
      const network = offlineMode ? "offline" : "online";
      const refresh = metadataEngine.setNetwork(network);
      queueEngine.setNetwork(network);
      await Promise.all([refresh, metadataEngine.setClient(client)]);
      if (forceRefresh) await metadataEngine.refresh();
      await coverEngine.refresh();
    } catch (caught) {
      pendingConnection = undefined;
      connectionStatus = "error";
      error = connectionError(caught);
    }
  }

  $effect(() => {
    const pending = pendingConnection;
    const status = metadataEngine.status;
    if (!pending || (status !== "refreshing" && status !== "ready" && status !== "error"))
      return;
    const { auth: credentials, client } = pending;

    if (status === "error") {
      pendingConnection = undefined;
      connectionStatus = "error";
      error = connectionError(metadataEngine.error);
      return;
    }

    // Cached metadata is usable while revalidation is still in flight.
    // Configure dependent engines once, not again when refreshing becomes ready.
    untrack(() => {
      if (activeClient !== client) {
        activeAuth = credentials;
        activeClient = client;
        coverEngine.setClient(client);
        queueEngine.setClient(client);
        trackEngine.setClient(client);
      }
    });
    if (status === "refreshing") return;

    pendingConnection = undefined;
    if (metadataEngine.warning) {
      connectionStatus = "error";
      refreshError = `Background refresh failed: ${connectionError(metadataEngine.warning)}`;
    } else if (offlineMode) {
      connectionStatus = "disconnected";
      applyOfflineLibrary().catch(() => {});
    } else {
      connectionStatus = "connected";
      authStore.save(credentials);
    }

    if (navigateAfterConnection) {
      navigateAfterConnection = false;
      connectionOpen = false;
      navigate("/library");
    }
  });
</script>

<svelte:head>
  <title>Navidrome Artists</title>
</svelte:head>

{#snippet icon(name: string)}
  <svg class="icon" aria-hidden="true"><use href={`#icon-${name}`}></use></svg>
{/snippet}

{#snippet settingsRoute(_params: RouteParams, router: RouteControls)}
  <header class="topbar track-list">
    <span class="topbar-spacer"></span>
    <strong class="type-title">Settings</strong>
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Home">{@render icon("home")}</a
    >
  </header>
  {@render alerts()}

  <section class="view settings-view">
    <span class="type-eyebrow muted">Settings</span>
    <h2 class="type-heading">
      {activeAuth ? "Music server" : "Connect to your music"}
    </h2>
    <p class="type-body muted">
      {activeAuth
        ? "Manage the server used for your library."
        : "Enter your Navidrome server details. Authentication stays on this device."}
    </p>

    <details class="connection-card" bind:open={connectionOpen}>
      <summary>
        <span
          class="connection-dot"
          class:offline={offlineMode}
          class:connected={!offlineMode && connectionStatus === "connected"}
          class:connecting={!offlineMode && connectionStatus === "connecting"}
          class:failed={!offlineMode && connectionStatus === "error"}
        ></span>
        <span class="connection-summary stack-xs">
          <strong class="type-title">
            {activeAuth?.host ?? "Add a server"}
          </strong>
          <small class="type-small muted">
            {activeAuth
              ? `${activeAuth.username} · ${connectionStatusLabel()}`
              : "Navidrome connection"}
          </small>
        </span>
        <span class="connection-chevron">{@render icon("chevron-down")}</span>
      </summary>

      <div class="connection-details">
        {#if activeAuth}
          <div class="connection-status type-small">
            <span>Status</span>
            <strong>{connectionStatusLabel()}</strong>
          </div>
          <button
            type="button"
            class="button"
            data-size="md"
            data-variant="neutral"
            disabled={offlineMode || loading || refreshing}
            onclick={() => loadArtists(activeAuth!, true)}
          >
            {offlineMode
              ? "Unavailable offline"
              : loading || refreshing
                ? "Refreshing…"
                : "Refresh library data"}
          </button>
          <h3 class="type-title">Edit connection</h3>
        {/if}

        <form class="stack-md" onsubmit={submitConnection}>
          <label class="stack-sm">
            Host
            <input
              type="text"
              bind:value={host}
              placeholder="https://music.example.com"
              autocomplete="url"
              required
            />
          </label>

          <label class="stack-sm">
            Username
            <input
              type="text"
              bind:value={username}
              autocomplete="username"
              required
            />
          </label>

          <label class="stack-sm">
            Password
            <input
              type="password"
              bind:value={password}
              autocomplete="current-password"
              required
            />
          </label>

          <button
            class="button"
            data-size="md"
            data-variant="neutral"
            type="submit"
            disabled={offlineMode || loading || refreshing}
          >
            {loading
              ? "Connecting…"
              : activeAuth
                ? "Save connection"
                : "Connect"}
          </button>

          <small>
            Authentication is saved in this browser after a successful login.
          </small>
        </form>
      </div>
    </details>

    <div class="settings-option">
      <div class="stack-xs">
        <strong class="type-title">Offline library</strong>
        <small class="type-small muted">
          {offlineScanning
            ? "Reading downloads catalog…"
            : "Show only music downloaded to this device."}
          <a class="text-link" href={router.href("/downloads")}
            >View downloads</a
          >
        </small>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          checked={offlineMode}
          disabled={offlineScanning}
          onchange={(event) => void setOfflineMode(event.currentTarget.checked)}
        />
        <span></span>
      </label>
    </div>
  </section>
  {@render miniPlayer()}
{/snippet}

{#snippet downloadsRoute(_params: RouteParams, router: RouteControls)}
  <header class="topbar track-list">
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/settings")}
      title="Settings"
    >
      {@render icon("back")}
    </a>
    <strong class="type-title">Downloads</strong>
    <span class="topbar-spacer"></span>
  </header>
  <section class="view stack-md">
    <h2 class="type-heading">Downloads</h2>
    <p class="type-small muted">
      Downloading first, then queued tracks and saved files, newest first.
    </p>
    {#if trackEngine.error}
      <p class="error type-small" role="status">
        {trackEngine.error instanceof Error
          ? trackEngine.error.message
          : String(trackEngine.error)}
      </p>
    {/if}
    {#if trackEngine.downloadsLoading}
      <p class="type-body muted" role="status">Reading downloaded files…</p>
    {/if}
    {#if trackEngine.downloads.length}
      <div class="track-list">
        {#each trackEngine.downloads as entry (entry.key)}
          <div class="track-item">
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
              <p class="type-caption muted">
                {entry.track.artist} — {entry.track.album}
              </p>
              {#if entry.status === "downloaded"}
                <p class="type-caption muted">
                  <time datetime={new Date(entry.downloadedAt).toISOString()}>
                    {new Date(entry.downloadedAt).toLocaleString()}
                  </time>
                  · {entry.format === "mp3" ? "MP3" : entry.contentType}
                </p>
              {/if}
            </div>
            <span class="type-caption muted">
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
      <p class="type-body muted">No downloaded files yet.</p>
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
  {@const artist = playback.track && metadataEngine.getArtist(playback.track.artistId)}
  {@const album = playback.track && metadataEngine.getAlbum(playback.track.albumId)}
  {@const albumArtist = album && metadataEngine.getArtist(album.artistId)}
  <dialog id="player-dialog" class="player-dialog" use:swipeToDismiss>
    <header class="topbar track-list">
      <button
        type="button"
        class="icon-button"
        data-size="md"
        data-variant="neutral"
        commandfor="player-dialog"
        command="close"
        title="Close player">{@render icon("chevron-down")}</button
      >
      <strong class="type-title">Now playing</strong>
      <span class="topbar-spacer"></span>
    </header>
    {@render alerts()}

    <section class="view player-view">
      <div class="player-main">
        <div class="artwork">
          {#if playback.track}
            {@const cover = coverEngine.getTrackCover(playback.track.id, {
              allowNetwork: !offlineMode,
            })}
            {#if cover.source}
              <img
                src={cover.source}
                alt=""
                loading="lazy"
                onload={cover.cache}
              />
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
                onclick={(event) =>
                  event.currentTarget.closest("dialog")?.close()}
              >
                {artist.name}
              </a>
              —
              <a
                class="text-link"
                href={`#${albumPath(albumArtist, album)}`}
                onclick={(event) =>
                  event.currentTarget.closest("dialog")?.close()}
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
            value={playback.position}
            disabled={!playback.duration}
            oninput={(event) =>
              playback.seek(event.currentTarget.valueAsNumber)}
          />
          <div class="playback-time type-caption">
            <span>{formatTime(playback.position)}</span>
            <span>{formatTime(playback.duration)}</span>
          </div>
        </div>

        <div class="controls">
          <button
            type="button"
            class="icon-button"
            data-size="md"
            data-variant="neutral"
            onclick={() => playback.previous()}
            disabled={!playback.hasPrevious && playback.position <= 0}
            title="Previous">{@render icon("previous")}</button
          >
          <button
            type="button"
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
            type="button"
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
            <span class="type-eyebrow muted">Up next</span>
            <h2 class="type-heading">
              {queue.length} track{queue.length === 1 ? "" : "s"}
            </h2>
          </div>
          {#if queue.length > 0}
            <button
              type="button"
              class="button"
              data-size="sm"
              data-variant="neutral"
              onclick={clearQueue}>Clear</button
            >
          {/if}
        </div>
        {#if queue.length > 0}
          <div class="track-list">
            {#each queue as item, index}
              {@const downloadStatus = trackEngine.getStatus(item.id)}
              <div class="track-item">
                <button
                  type="button"
                  class="track-target"
                  aria-label={`Play ${item.title}`}
                  onclick={() => playback.playIndex(index)}
                ></button>
                <span class="track-leading">
                  {#if index === playback.currentIndex && playbackLoading}
                    <span role="img" aria-label="Loading playback">
                      {@render icon("loading")}
                    </span>
                  {:else if index === playback.currentIndex && playback.playing}
                    <span role="img" aria-label="Playing">
                      {@render icon("sound-bars")}
                    </span>
                  {:else if index === playback.currentIndex}
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
                    {index + 1}
                  {/if}
                </span>
                <span class="track-content">
                  <span>{item.title}</span>
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="type-body muted">The queue is empty.</p>
        {/if}
      </div>
    </section>
  </dialog>
{/snippet}

{#snippet libraryRoute(_params: RouteParams, router: RouteControls)}
  {@const visibleArtists = offlineMode
    ? artists.filter((artist) =>
        artistTracks(artist).some(
          (track) => trackEngine.getStatus(track.id) === "downloaded",
        ),
      )
    : artists}

  <header class="topbar track-list">
    <span class="topbar-spacer"></span>
    <strong class="type-title">Library</strong>
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/settings")}
      title="Settings">{@render icon("settings")}</a
    >
  </header>
  {@render alerts()}

  <section class="view library-view">
    {#if activeClient && !error}
      <div class="section-heading">
        <div>
          <span class="type-eyebrow muted">
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
            {@const cover = coverEngine.getArtistCover(artist.id, { allowNetwork: !offlineMode })}
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
                type="button"
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
              <dialog
                id={menuId}
                class="action-menu"
                aria-labelledby={`${menuId}-title`}
                closedby="closerequest"
                use:swipeToDismiss
                onclick={(event) => event.currentTarget.close()}
              >
                <header class="action-menu-heading">
                  <strong id={`${menuId}-title`} class="type-title">
                    {artist.name}
                  </strong>
                </header>
                <div class="track-list">
                  <button
                    type="button"
                    class="track-item action-menu-item"
                    onclick={() => playArtist(artist)}
                  >
                    {@render icon("play")}
                    <span>Play</span>
                  </button>
                  <button
                    type="button"
                    class="track-item action-menu-item"
                    onclick={() => playNext(artistTracks(artist))}
                  >
                    {@render icon("next")}
                    <span>Play next</span>
                  </button>
                  <button
                    type="button"
                    class="track-item action-menu-item"
                    onclick={() => playLast(artistTracks(artist))}
                  >
                    {@render icon("plus")}
                    <span>Play last</span>
                  </button>
                  <button
                    type="button"
                    class="track-item action-menu-item"
                    onclick={() => downloadArtist(artist)}
                  >
                    {@render icon("download")}
                    <span>Download</span>
                  </button>
                </div>
                <button type="button" class="button" data-variant="neutral">
                  Cancel
                </button>
              </dialog>
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
  {@render miniPlayer()}
{/snippet}

{#snippet artistRoute(params: RouteParams, router: RouteControls)}
  {@const artist = params.artistId
    ? metadataEngine.getArtist(params.artistId)
    : undefined}
  {@const visibleAlbums = artist
    ? offlineMode
      ? metadataEngine.getArtistAlbums(artist.id).filter((album) =>
          metadataEngine.getAlbumTracks(album.id).some(
            (track) => trackEngine.getStatus(track.id) === "downloaded",
          ),
        )
      : metadataEngine.getArtistAlbums(artist.id)
    : []}

  <header class="topbar track-list">
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Back">{@render icon("back")}</a
    >
    <strong class="type-title">Library</strong>
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Home">{@render icon("home")}</a
    >
  </header>
  {@render alerts()}

  <section class="view library-view">
    {#if activeClient && !error && artist}
      {@const artwork = coverEngine.getArtistCover(artist.id, {
        allowNetwork: !offlineMode,
      })}
      <div class="collection-art collection-art-artist" aria-hidden="true">
        {#if artwork.source}
          <img src={artwork.source} alt="" onload={artwork.cache} />
        {:else}
          {@render icon("music")}
        {/if}
      </div>
      <div class="section-heading collection-heading">
        <div>
          <span class="type-eyebrow muted">Albums</span>
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
          type="button"
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          commandfor="artist-page-menu"
          command="show-modal"
          title={`Open menu for ${artist.name}`}
        >
          {@render icon("menu")}
        </button>
        <dialog
          id="artist-page-menu"
          class="action-menu"
          aria-labelledby="artist-page-menu-title"
          closedby="closerequest"
          use:swipeToDismiss
          onclick={(event) => event.currentTarget.close()}
        >
          <header class="action-menu-heading">
            <strong id="artist-page-menu-title" class="type-title">
              {artist.name}
            </strong>
          </header>
          <div class="track-list">
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => playArtist(artist)}
            >
              {@render icon("play")}
              <span>Play</span>
            </button>
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => playNext(artistTracks(artist))}
            >
              {@render icon("next")}
              <span>Play next</span>
            </button>
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => playLast(artistTracks(artist))}
            >
              {@render icon("plus")}
              <span>Play last</span>
            </button>
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => downloadArtist(artist)}
            >
              {@render icon("download")}
              <span>Download</span>
            </button>
          </div>
          <button type="button" class="button" data-variant="neutral">
            Cancel
          </button>
        </dialog>
      </div>

      {#if offlineScanning}
        <div class="empty-state">
          <div class="scan-spinner">{@render icon("loading")}</div>
          <p class="type-body">Checking downloaded music…</p>
        </div>
      {:else}
        <div class="track-list">
          {#each visibleAlbums as album, index}
            {@const albumMenuId = `album-menu-${index}`}
            {@const visibleTracks = offlineMode
              ? metadataEngine.getAlbumTracks(album.id).filter(
                  (track) => trackEngine.getStatus(track.id) === "downloaded",
                )
              : metadataEngine.getAlbumTracks(album.id)}
            {@const cover = coverEngine.getAlbumCover(album.id, { allowNetwork: !offlineMode })}
            <article class="track-item">
              <a
                class="track-target"
                href={router.href(albumPath(artist, album))}
                aria-label={`Open ${album.title}`}
                data-longpressfor={albumMenuId}
                data-longpress="show-modal"
                title={`${album.title} — hold for actions`}
              ></a>
              <span class="track-leading album-leading">
                <span class="cover album-cover">
                  {#if cover.source}
                    <img src={cover.source} alt="" loading="lazy" onload={cover.cache} />
                  {:else}
                    <span>{@render icon("music")}</span>
                  {/if}
                </span>
              </span>
              <span class="track-content stack-xs">
                <strong class="type-title">{album.title}</strong>
                <small class="type-small muted">
                  {album.year ?? "Unknown year"} · {visibleTracks.length} tracks
                </small>
              </span>
              <span class="track-actions">
                <button
                  type="button"
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  commandfor={albumMenuId}
                  command="show-modal"
                  title={`Open menu for ${album.title}`}
                >
                  {@render icon("menu")}
                </button>
                <dialog
                  id={albumMenuId}
                  class="action-menu"
                  aria-labelledby={`${albumMenuId}-title`}
                  closedby="closerequest"
                  use:swipeToDismiss
                  onclick={(event) => event.currentTarget.close()}
                >
                  <header class="action-menu-heading">
                    <strong id={`${albumMenuId}-title`} class="type-title">
                      {album.title}
                    </strong>
                  </header>
                  <div class="track-list">
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() => playAlbum(album)}
                    >
                      {@render icon("play")}
                      <span>Play</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() => playNext(metadataEngine.getAlbumTracks(album.id))}
                    >
                      {@render icon("next")}
                      <span>Play next</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() => playLast(metadataEngine.getAlbumTracks(album.id))}
                    >
                      {@render icon("plus")}
                      <span>Play last</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() => downloadAlbum(album)}
                    >
                      {@render icon("download")}
                      <span>Download</span>
                    </button>
                  </div>
                  <button type="button" class="button" data-variant="neutral">
                    Cancel
                  </button>
                </dialog>
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
          {activeClient ? "Artist not found." : "Connect your library."}
        </p>
        <a
          class="button"
          data-size="md"
          data-variant="neutral"
          href={router.href(activeClient ? "/library" : "/settings")}
        >
          {activeClient ? "Open library" : "Open settings"}
        </a>
      </div>
    {/if}
  </section>
  {@render miniPlayer()}
{/snippet}

{#snippet albumRoute(params: RouteParams, router: RouteControls)}
  {@const artist = params.artistId
    ? metadataEngine.getArtist(params.artistId)
    : undefined}
  {@const album = params.albumId
    ? metadataEngine.getAlbum(params.albumId)
    : undefined}
  {@const visibleTracks = album
    ? offlineMode
      ? metadataEngine.getAlbumTracks(album.id).filter(
          (track) => trackEngine.getStatus(track.id) === "downloaded",
        )
      : metadataEngine.getAlbumTracks(album.id)
    : []}

  <header class="topbar track-list">
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={artist ? router.href(artistPath(artist)) : router.href("/library")}
      title="Back">{@render icon("back")}</a
    >
    <strong class="type-title">Library</strong>
    <a
      class="icon-button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/library")}
      title="Home">{@render icon("home")}</a
    >
  </header>
  {@render alerts()}

  <section class="view library-view">
    {#if activeClient && !error && artist && album}
      {@const artwork = coverEngine.getAlbumCover(album.id, {
        allowNetwork: !offlineMode,
      })}
      <div class="collection-art collection-art-album" aria-hidden="true">
        {#if artwork.source}
          <img src={artwork.source} alt="" onload={artwork.cache} />
        {:else}
          {@render icon("music")}
        {/if}
      </div>
      <div class="section-heading collection-heading">
        <div>
          <a
            class="text-link type-eyebrow muted"
            href={router.href(artistPath(artist))}>{artist.name}</a
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
          type="button"
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          commandfor="album-page-menu"
          command="show-modal"
          title={`Open menu for ${album.title}`}
        >
          {@render icon("menu")}
        </button>
        <dialog
          id="album-page-menu"
          class="action-menu"
          aria-labelledby="album-page-menu-title"
          closedby="closerequest"
          use:swipeToDismiss
          onclick={(event) => event.currentTarget.close()}
        >
          <header class="action-menu-heading">
            <strong id="album-page-menu-title" class="type-title">
              {album.title}
            </strong>
          </header>
          <div class="track-list">
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => playAlbum(album)}
            >
              {@render icon("play")}
              <span>Play</span>
            </button>
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => playNext(metadataEngine.getAlbumTracks(album.id))}
            >
              {@render icon("next")}
              <span>Play next</span>
            </button>
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => playLast(metadataEngine.getAlbumTracks(album.id))}
            >
              {@render icon("plus")}
              <span>Play last</span>
            </button>
            <button
              type="button"
              class="track-item action-menu-item"
              onclick={() => downloadAlbum(album)}
            >
              {@render icon("download")}
              <span>Download</span>
            </button>
          </div>
          <button type="button" class="button" data-variant="neutral">
            Cancel
          </button>
        </dialog>
      </div>

      {#if offlineScanning}
        <div class="empty-state">
          <div class="scan-spinner">{@render icon("loading")}</div>
          <p class="type-body">Checking downloaded music…</p>
        </div>
      {:else}
        <div class="track-list">
          {#each visibleTracks as track, index}
            {@const trackMenuId = `album-track-menu-${index}`}
            {@const downloadStatus = trackEngine.getStatus(track.id)}
            <div class="track-item">
              <button
                type="button"
                class="track-target"
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
              <span class="track-content">
                <span>{track.title}</span>
              </span>
              <span class="track-actions">
                <button
                  type="button"
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  commandfor={trackMenuId}
                  command="show-modal"
                  title={`Open menu for ${track.title}`}
                >
                  {@render icon("menu")}
                </button>
                <dialog
                  id={trackMenuId}
                  class="action-menu"
                  aria-labelledby={`${trackMenuId}-title`}
                  closedby="closerequest"
                  use:swipeToDismiss
                  onclick={(event) => event.currentTarget.close()}
                >
                  <header class="action-menu-heading">
                    <strong id={`${trackMenuId}-title`} class="type-title">
                      {track.title}
                    </strong>
                  </header>
                  <div class="track-list">
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() => playTrack(track)}
                    >
                      {@render icon("play")}
                      <span>Play</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() =>
                        playNext([track])}
                    >
                      {@render icon("next")}
                      <span>Play next</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"
                      onclick={() =>
                        playLast([track])}
                    >
                      {@render icon("plus")}
                      <span>Play last</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"
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
                  </div>
                  <button type="button" class="button" data-variant="neutral">
                    Cancel
                  </button>
                </dialog>
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
          {activeClient ? "Album not found." : "Connect your library."}
        </p>
        <a
          class="button"
          data-size="md"
          data-variant="neutral"
          href={router.href(activeClient ? "/library" : "/settings")}
        >
          {activeClient ? "Open library" : "Open settings"}
        </a>
      </div>
    {/if}
  </section>
  {@render miniPlayer()}
{/snippet}

{#snippet connectLibrary(router: RouteControls)}
  <div class="empty-state">
    <span>{@render icon("music")}</span>
    <h2 class="type-heading">Connect your library</h2>
    <p class="type-body">Add your Navidrome server to start listening.</p>
    <a
      class="button"
      data-size="md"
      data-variant="neutral"
      href={router.href("/settings")}>Open settings</a
    >
  </div>
{/snippet}

{#snippet miniPlayer()}
  {#if playback.track}
    {@const cover = coverEngine.getTrackCover(playback.track.id, { allowNetwork: !offlineMode })}
    <div class="mini-player track-list">
      <div class="track-item">
        <button
          class="track-target"
          type="button"
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
          <small class="type-small muted">
            {metadataEngine.getArtist(playback.track.artistId)?.name}
          </small>
        </span>
        <button
          type="button"
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
      </div>
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

<WebappUpdater />
