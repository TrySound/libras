<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import PwaUpdate from "./pwa-update.svelte";
  import { AuthStore } from "./auth";
  import { CoverEngine } from "./cover-engine";
  import {
    MetadataEngine,
    type Album,
    type Artist,
    type Track,
  } from "./metadata-engine";
  import { QueueEngine, type QueueTrack } from "./queue-engine";
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

  type QueueItem = QueueTrack;

  type SavedAuth = SubsonicAuth;

  type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

  let host = $state("");
  let username = $state("");
  let password = $state("");
  const metadataEngine = new MetadataEngine();
  const queueEngine = new QueueEngine();
  let navigate = $state<RouterNavigate>(() => {});
  let artists = $derived(metadataEngine.getArtists());
  let queue = $derived(queueEngine.tracks);
  let activeAuth = $state<SavedAuth | null>(null);
  let activeClient = $state<SubsonicClient>();
  let currentIndex = $derived(
    queueEngine.current
      ? queue.findIndex((track) => track.id === queueEngine.current)
      : -1,
  );
  let currentTime = $derived(queueEngine.position);
  let duration = $state(0);
  let isPlaying = $state(false);
  let playbackLoading = $state(false);
  let playbackError = $state("");
  let audio: HTMLAudioElement;
  const coverEngine = new CoverEngine();
  const trackEngine = new TrackEngine();
  let lastPositionSync = 0;
  let playbackRequest = 0;
  let playbackSourceCached = false;
  let downloadingCollection = $state("");
  let offlineMode = $state(false);
  let offlineScanning = $state(false);
  let loading = $derived(metadataEngine.status === "loading");
  let refreshing = $derived(metadataEngine.status === "refreshing");
  let refreshError = $state("");
  let error = $state("");
  let connectedHost = $state("");
  let connectionStatus = $state<ConnectionStatus>("disconnected");
  let connectionOpen = $state(false);
  let pendingAuth = $state<SavedAuth | null>(null);
  let pendingClient = $state<SubsonicClient>();
  let navigateAfterConnection = $state(false);

  $effect(() => {
    const tracks = queueEngine.tracks;
    untrack(() => void refreshDownloadedState([...tracks]));
  });

  onDestroy(() => {
    coverEngine.destroy();
    metadataEngine.destroy();
    queueEngine.destroy();
    trackEngine.destroy();
  });

  onMount(() => {
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
      loadArtists(savedAuth);
    } catch {
      authStore.clear();
      connectionOpen = true;
      navigate("/settings", "replace");
    }
  });

  onMount(() => {
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") queueEngine.flush();
    };

    document.addEventListener("visibilitychange", saveWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", saveWhenHidden);
  });

  function scanLibrarySelection(
    _node: HTMLElement,
    selection: { album?: Album; artist?: Artist },
  ) {
    const scan = ({ album, artist }: typeof selection) => {
      if (!artist) return;
      void refreshDownloadedState(
        album ? albumQueueItems(artist, album) : artistQueueItems(artist),
      );
    };
    scan(selection);
    return { update: scan };
  }

  function artistPath(artist: Artist) {
    return `/library/artist/${encodeURIComponent(artist.id ?? artist.name)}`;
  }

  function albumPath(artist: Artist, album: Album) {
    return `${artistPath(artist)}/album/${encodeURIComponent(album.id)}`;
  }

  function albumsFor(artist: Artist) {
    return metadataEngine.getArtist(artist.id ?? artist.name)?.albums ?? [];
  }

  function tracksFor(album: Album) {
    return metadataEngine.getAlbum(album.id)?.tracks ?? [];
  }

  function artistCoverArt(artist: Artist) {
    return (
      artist.coverArt ??
      albumsFor(artist).find((album) => album.coverArt)?.coverArt
    );
  }

  function artistCoverArts(artist: Artist) {
    return [
      artist.coverArt,
      ...albumsFor(artist).flatMap((album) => [
        album.coverArt,
        ...tracksFor(album).map((track) => track.coverArt),
      ]),
    ];
  }

  function albumCoverArts(album: Album) {
    return [album.coverArt, ...tracksFor(album).map((track) => track.coverArt)];
  }

  function directGenres(item: { genre?: string; genres?: { name: string }[] }) {
    const genres = [
      ...(item.genres?.map((genre) => genre.name) ?? []),
      ...(item.genre ? [item.genre] : []),
    ];
    return genres
      .flatMap((genre) => genre.split("|"))
      .map((genre) => genre.trim())
      .filter(Boolean);
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
      ...directGenres(album),
      ...tracksFor(album).flatMap(directGenres),
    ]);
  }

  function artistGenres(artist: Artist) {
    return uniqueGenres([
      ...directGenres(artist),
      ...albumsFor(artist).flatMap(albumGenres),
    ]);
  }

  function albumQueueItems(artist: Artist, album: Album): QueueItem[] {
    return tracksFor(album).map((track) => ({
      album: album.name,
      artist: artist.name,
      contentType: track.contentType,
      coverArt: track.coverArt ?? album.coverArt ?? artistCoverArt(artist),
      id: track.id,
      title: track.title,
    }));
  }

  function artistQueueItems(artist: Artist): QueueItem[] {
    return albumsFor(artist).flatMap((album) => albumQueueItems(artist, album));
  }

  function availableQueueItems(items: QueueItem[]) {
    return offlineMode
      ? items.filter(
          (track) => trackEngine.getStatus(track.id) === "downloaded",
        )
      : items;
  }

  function trackQueueItem(
    artist: Artist,
    album: Album,
    track: Track,
  ): QueueItem {
    return {
      album: album.name,
      artist: artist.name,
      contentType: track.contentType,
      coverArt: track.coverArt ?? album.coverArt ?? artistCoverArt(artist),
      id: track.id,
      title: track.title,
    };
  }

  function playAlbum(artist: Artist, album: Album) {
    replaceQueueAndPlay(availableQueueItems(albumQueueItems(artist, album)));
  }

  function playArtist(artist: Artist) {
    replaceQueueAndPlay(availableQueueItems(artistQueueItems(artist)));
  }

  function playNext(tracks: QueueItem[]) {
    const items = availableQueueItems(tracks);
    if (items.length === 0) return;
    if (queue.length === 0) {
      replaceQueueAndPlay(items);
      return;
    }

    const insertAt = Math.max(0, currentIndex + 1);
    queueEngine.update({
      current: queueEngine.current,
      position: currentTime,
      tracks: [...queue.slice(0, insertAt), ...items, ...queue.slice(insertAt)],
    });
  }

  function playLast(tracks: QueueItem[]) {
    const items = availableQueueItems(tracks);
    if (items.length === 0) return;
    if (queue.length === 0) {
      replaceQueueAndPlay(items);
      return;
    }

    queueEngine.update({
      current: queueEngine.current,
      position: currentTime,
      tracks: [...queue, ...items],
    });
  }

  function playTrack(artist: Artist, album: Album, track: Track) {
    const albumTracks = availableQueueItems(albumQueueItems(artist, album));
    const selectedIndex = albumTracks.findIndex((item) => item.id === track.id);
    replaceQueueAndPlay(albumTracks, Math.max(0, selectedIndex));
  }

  async function downloadQueueTrack(track: QueueItem) {
    try {
      await trackEngine.cache(track);
    } catch (caught) {
      playbackError =
        caught instanceof Error
          ? caught.message
          : "The track could not be downloaded.";
    }
  }

  async function downloadTracks(items: QueueItem[]) {
    let nextTrack = 0;

    async function worker() {
      while (nextTrack < items.length) {
        const track = items[nextTrack++];
        await downloadQueueTrack(track);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(3, items.length) }, () => worker()),
    );
  }

  async function downloadAlbum(artist: Artist, album: Album) {
    const key = `album:${album.id}`;
    downloadingCollection = key;
    try {
      await downloadTracks(albumQueueItems(artist, album));
    } finally {
      if (downloadingCollection === key) downloadingCollection = "";
    }
  }

  async function downloadArtist(artist: Artist) {
    const key = `artist:${artist.id ?? artist.name}`;
    downloadingCollection = key;
    try {
      await downloadTracks(artistQueueItems(artist));
    } finally {
      if (downloadingCollection === key) downloadingCollection = "";
    }
  }

  function downloadLibraryTrack(artist: Artist, album: Album, track: Track) {
    void downloadQueueTrack(trackQueueItem(artist, album, track));
  }

  async function refreshDownloadedState(items: QueueItem[]) {
    if (!activeAuth) return;
    await trackEngine.scanCached(items);
  }

  async function scanOfflineLibrary() {
    if (!activeAuth) return;

    offlineScanning = true;
    try {
      const libraryTracks = artists.flatMap(artistQueueItems);
      await refreshDownloadedState(libraryTracks);

      const currentTrackId = queue[currentIndex]?.id;
      const offlineQueue = queue.filter(
        (track) => trackEngine.getStatus(track.id) === "downloaded",
      );
      const offlineIndex = currentTrackId
        ? offlineQueue.findIndex((track) => track.id === currentTrackId)
        : -1;

      if (currentTrackId && offlineIndex < 0) stopPlayback();
      queueEngine.update({
        current: offlineIndex >= 0 ? currentTrackId : undefined,
        position: offlineIndex >= 0 ? currentTime : 0,
        tracks: offlineQueue,
      });
    } finally {
      offlineScanning = false;
    }
  }

  async function setOfflineMode(enabled: boolean) {
    offlineMode = enabled;
    localStorage.setItem(offlineModeStorageKey, String(enabled));

    const network = enabled ? "offline" : "online";
    metadataEngine.setNetwork(network);
    queueEngine.setNetwork(network);
    if (enabled) await scanOfflineLibrary();
    else if (activeAuth) loadArtists(activeAuth);
  }

  function collectionIsDownloaded(items: QueueItem[]) {
    return (
      items.length > 0 &&
      items.every((track) => trackEngine.getStatus(track.id) === "downloaded")
    );
  }

  function updatePlaybackTime() {
    queueEngine.setPosition(audio.currentTime);
    if (Date.now() - lastPositionSync >= 10_000) {
      lastPositionSync = Date.now();
      queueEngine.flush();
    }
  }

  function replaceQueueAndPlay(items: QueueItem[], startIndex = 0) {
    const index =
      items.length > 0 ? Math.min(startIndex, items.length - 1) : -1;
    queueEngine.update({
      current: items[index]?.id,
      position: 0,
      tracks: items,
    });
    if (index >= 0) void playCurrent();
    else stopPlayback();
  }

  function unsupportedSource(caught: unknown) {
    return (
      (caught instanceof DOMException && caught.name === "NotSupportedError") ||
      (caught instanceof Error && /supported sources/i.test(caught.message))
    );
  }

  async function playCurrent(startAt = currentTime, forceTranscode = false) {
    const track = queue[currentIndex];
    if (!track) return;

    const request = ++playbackRequest;
    playbackError = "";
    playbackLoading = true;
    if (startAt <= 0) duration = 0;
    queueEngine.save();

    const playSource = async (forceTranscode: boolean) => {
      const source = await trackEngine.getSource(track, { forceTranscode });
      if (request !== playbackRequest) return;

      playbackSourceCached = source.cached;
      audio.src = source.url;
      if (source.cached && startAt > 0) {
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolve, reject) => {
            const loaded = () => {
              audio.removeEventListener("error", failed);
              resolve();
            };
            const failed = () => {
              audio.removeEventListener("loadedmetadata", loaded);
              reject(
                new DOMException(
                  "The cached track could not be played.",
                  "NotSupportedError",
                ),
              );
            };
            audio.addEventListener("loadedmetadata", loaded, { once: true });
            audio.addEventListener("error", failed, { once: true });
          });
        }
        if (request !== playbackRequest) return;
        audio.currentTime = Math.min(startAt, audio.duration || startAt);
        queueEngine.setPosition(audio.currentTime);
      }
      await audio.play();
      if (!source.cached && request === playbackRequest) {
        void trackEngine.cache(track, { forceTranscode }).catch(() => {});
      }
    };

    try {
      try {
        await playSource(forceTranscode);
      } catch (caught) {
        if (
          forceTranscode ||
          request !== playbackRequest ||
          !unsupportedSource(caught)
        )
          throw caught;
        playbackError = "";
        playbackLoading = true;
        await playSource(true);
      }
    } catch (caught) {
      if (request !== playbackRequest) return;
      playbackLoading = false;
      playbackError =
        caught instanceof Error ? caught.message : "Playback failed.";
    }
  }

  function stopPlayback() {
    playbackRequest += 1;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    trackEngine.releaseSource();
    playbackSourceCached = false;
    queueEngine.update({ tracks: queue, position: 0 });
    duration = 0;
    isPlaying = false;
    playbackLoading = false;
  }

  function clearQueue() {
    stopPlayback();
    queueEngine.update({ tracks: [], position: 0 });
  }

  function togglePlayback() {
    if (audio.paused) {
      if (currentIndex < 0 && queue.length > 0) {
        queueEngine.update({
          current: queue[0].id,
          position: 0,
          tracks: queue,
        });
        void playCurrent();
      } else if (!audio.currentSrc) {
        void playCurrent();
      } else {
        void audio.play().catch((caught: unknown) => {
          playbackError =
            caught instanceof Error ? caught.message : "Playback failed.";
        });
      }
    } else {
      audio.pause();
      playbackLoading = false;
      queueEngine.flush();
    }
  }

  function playQueueIndex(index: number) {
    queueEngine.update({
      current: queue[index]?.id,
      position: 0,
      tracks: queue,
    });
    void playCurrent();
  }

  function nextTrack() {
    if (currentIndex + 1 >= queue.length) {
      audio.pause();
      isPlaying = false;
      playbackLoading = false;
      queueEngine.flush();
      return;
    }
    queueEngine.update({
      current: queue[currentIndex + 1].id,
      position: 0,
      tracks: queue,
    });
    void playCurrent();
  }

  function previousTrack() {
    if (audio.currentTime > 3 || currentIndex <= 0) {
      audio.currentTime = 0;
      queueEngine.setPosition(0);
      queueEngine.save();
      return;
    }
    queueEngine.update({
      current: queue[currentIndex - 1].id,
      position: 0,
      tracks: queue,
    });
    void playCurrent();
  }

  async function cacheAndSeek(value: number) {
    const track = queue[currentIndex];
    if (!track) return;

    const request = ++playbackRequest;
    audio.pause();
    playbackError = "";
    playbackLoading = true;
    try {
      await trackEngine.cache(track, { forceTranscode: true });
      if (request !== playbackRequest) return;
      await playCurrent(value, true);
    } catch (caught) {
      if (request !== playbackRequest) return;
      playbackLoading = false;
      playbackError =
        caught instanceof Error
          ? caught.message
          : "The track could not be loaded.";
    }
  }

  function seek(value: number) {
    if (!Number.isFinite(value)) return;

    const buffered = Array.from(
      { length: audio.buffered.length },
      (_, index) =>
        value >= audio.buffered.start(index) &&
        value <= audio.buffered.end(index),
    ).some(Boolean);

    queueEngine.setPosition(value);
    if (playbackSourceCached || buffered) {
      audio.currentTime = value;
      queueEngine.save();
    } else {
      void cacheAndSeek(value);
    }
  }

  function playbackPercent() {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
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

  function loadArtists(savedAuth?: SavedAuth, forceRefresh = false) {
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

      pendingAuth = credentials;
      pendingClient = client;
      const network = offlineMode ? "offline" : "online";
      metadataEngine.setNetwork(network);
      queueEngine.setNetwork(network);
      metadataEngine.setClient(client);
      if (forceRefresh) metadataEngine.refresh();
    } catch (caught) {
      pendingAuth = null;
      pendingClient = undefined;
      connectionStatus = "error";
      error = connectionError(caught);
    }
  }

  $effect(() => {
    const credentials = pendingAuth;
    const client = pendingClient;
    const status = metadataEngine.status;
    if (!credentials || !client || (status !== "ready" && status !== "error"))
      return;

    pendingAuth = null;
    pendingClient = undefined;
    if (status === "error") {
      connectionStatus = "error";
      error = connectionError(metadataEngine.error);
      return;
    }

    activeAuth = credentials;
    activeClient = client;
    coverEngine.setClient(client);
    queueEngine.setClient(client);
    trackEngine.setClient(client);
    connectedHost = credentials.host;

    if (metadataEngine.warning) {
      connectionStatus = "error";
      refreshError = `Background refresh failed: ${connectionError(metadataEngine.warning)}`;
    } else if (offlineMode) {
      connectionStatus = "disconnected";
      scanOfflineLibrary().catch(() => {});
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

<main class="app-shell">
  <audio
    bind:this={audio}
    preload="metadata"
    onplay={() => (isPlaying = true)}
    onplaying={() => {
      isPlaying = true;
      playbackLoading = false;
    }}
    onpause={() => (isPlaying = false)}
    onwaiting={() => (playbackLoading = true)}
    oncanplay={() => (playbackLoading = false)}
    onended={nextTrack}
    ontimeupdate={updatePlaybackTime}
    onloadedmetadata={() => {
      duration = audio.duration;
      if (currentTime > 0) {
        audio.currentTime = Math.min(currentTime, duration || currentTime);
        queueEngine.setPosition(audio.currentTime);
      }
    }}
    onerror={() => {
      playbackLoading = false;
      if (audio.currentSrc) playbackError = "The track could not be played.";
    }}
  ></audio>

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
            <strong class="type-title"
              >{activeAuth?.host ?? "Add a server"}</strong
            >
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

            <small
              >Authentication is saved in this browser after a successful login.</small
            >
          </form>
        </div>
      </details>

      <div class="settings-option">
        <div class="stack-xs">
          <strong class="type-title">Offline library</strong>
          <small class="type-small muted">
            {offlineScanning
              ? "Checking downloaded tracks…"
              : "Show only music downloaded to this device."}
          </small>
        </div>
        <label class="switch">
          <input
            type="checkbox"
            checked={offlineMode}
            disabled={offlineScanning}
            onchange={(event) =>
              void setOfflineMode(event.currentTarget.checked)}
          />
          <span></span>
        </label>
      </div>
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
            {#if currentIndex >= 0 && queue[currentIndex]?.coverArt}
              {@const cover = coverEngine.getCover({
                candidates: [queue[currentIndex].coverArt],
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

          {#if currentIndex >= 0 && queue[currentIndex]}
            <p class="type-body">
              <strong class="type-heading">{queue[currentIndex].title}</strong
              ><br />
              {queue[currentIndex].artist} — {queue[currentIndex].album}
            </p>
          {/if}

          <div class="playback-progress">
            <input
              class="playback-slider"
              type="range"
              min="0"
              max={Number.isFinite(duration) ? duration : 0}
              step="0.1"
              value={currentTime}
              disabled={!duration}
              oninput={(event) => seek(event.currentTarget.valueAsNumber)}
            />
            <div class="playback-time type-caption">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div class="controls">
            <button
              type="button"
              class="icon-button"
              data-size="md"
              data-variant="neutral"
              onclick={previousTrack}
              disabled={currentIndex <= 0}
              title="Previous">{@render icon("previous")}</button
            >
            <button
              type="button"
              class="icon-button"
              data-size="lg"
              data-variant="primary"
              onclick={togglePlayback}
              disabled={queue.length === 0}
              title={isPlaying ? "Pause" : "Play"}
            >
              {#if playbackLoading}
                {@render icon("loading")}
              {:else if isPlaying}
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
              onclick={nextTrack}
              disabled={currentIndex < 0 || currentIndex + 1 >= queue.length}
              title="Next">{@render icon("next")}</button
            >
          </div>

          {#if playbackError}
            <p class="error type-small">{playbackError}</p>
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
                <div class="track-item" class:current={index === currentIndex}>
                  <span class="track-leading">{index + 1}</span>
                  <button
                    type="button"
                    class="track-content"
                    onclick={() => playQueueIndex(index)}
                  >
                    <span>{item.title}</span>
                  </button>
                  <span class="track-actions">
                  <button
                    type="button"
                    class="icon-button"
                    data-size="sm"
                    data-variant="ghost"
                    onclick={() => downloadQueueTrack(item)}
                    title="Download track"
                  >
                    {#if index === currentIndex && playbackLoading}
                      {@render icon("loading")}
                    {:else if index === currentIndex && isPlaying}
                      {@render icon("sound-bars")}
                    {:else if trackEngine.getStatus(item.id) === "downloading"}
                      {@render icon("loading")}
                    {:else if trackEngine.getStatus(item.id) === "downloaded"}
                      {@render icon("check")}
                    {:else}
                      {@render icon("download")}
                    {/if}
                  </button>
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
          artistQueueItems(artist).some(
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
      {#if connectedHost && !error}
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
              <article class="artist-card">
                <a class="artist-main" href={router.href(artistPath(artist))}>
                  <span class="cover artist-cover">
                    {#if artistCoverArts(artist).some(Boolean)}
                      {@const cover = coverEngine.getCover({
                        candidates: artistCoverArts(artist),
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
                    <strong class="artist-name type-small">{artist.name}</strong
                    >
                  </span>
                </a>
                <button
                  type="button"
                  class="icon-button artist-menu-trigger"
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
                    <strong id={`${menuId}-title`} class="type-title">{artist.name}</strong>
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

                      onclick={() => playNext(artistQueueItems(artist))}
                    >
                      {@render icon("next")}
                      <span>Play next</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playLast(artistQueueItems(artist))}
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
                  <button
                    type="button"
                    class="button"
                    data-variant="neutral"

                  >Cancel</button>
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
        ? albumsFor(artist).filter((album) =>
            tracksFor(album).some(
              (track) => trackEngine.getStatus(track.id) === "downloaded",
            ),
          )
        : albumsFor(artist)
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

    <section class="view library-view" use:scanLibrarySelection={{ artist }}>
      {#if connectedHost && !error && artist}
        {@const artwork = coverEngine.getCover({
          candidates: artistCoverArts(artist),
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
              {visibleAlbums.length} album{visibleAlbums.length === 1
                ? ""
                : "s"}
            </p>
            {#if artistGenres(artist).length > 0}
              <div class="genre-list">
                {#each artistGenres(artist) as genre}<span class="type-caption"
                    >{genre}</span
                  >{/each}
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
              <strong id="artist-page-menu-title" class="type-title">{artist.name}</strong>
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

                onclick={() => playNext(artistQueueItems(artist))}
              >
                {@render icon("next")}
                <span>Play next</span>
              </button>
              <button
                type="button"
                class="track-item action-menu-item"

                onclick={() => playLast(artistQueueItems(artist))}
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
            <button
              type="button"
              class="button"
              data-variant="neutral"

            >Cancel</button>
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
                ? tracksFor(album).filter(
                    (track) => trackEngine.getStatus(track.id) === "downloaded",
                  )
                : tracksFor(album)}
              <article class="track-item">
                <a
                  class="track-leading album-leading"
                  href={router.href(albumPath(artist, album))}
                >
                  <span class="cover album-cover">
                    {#if albumCoverArts(album).some(Boolean)}
                      {@const cover = coverEngine.getCover({
                        candidates: albumCoverArts(album),
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
                  </span>
                </a>
                <a
                  class="track-content stack-xs"
                  href={router.href(albumPath(artist, album))}
                >
                  <strong class="type-title">{album.name}</strong>
                  <small class="type-small muted"
                    >{album.year ?? "Unknown year"} · {visibleTracks.length} tracks</small
                  >
                </a>
                <span class="track-actions">
                <button
                  type="button"
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  commandfor={albumMenuId}
                  command="show-modal"
                  title={`Open menu for ${album.name}`}
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
                    <strong id={`${albumMenuId}-title`} class="type-title">{album.name}</strong>
                  </header>
                  <div class="track-list">
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playAlbum(artist, album)}
                    >
                      {@render icon("play")}
                      <span>Play</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playNext(albumQueueItems(artist, album))}
                    >
                      {@render icon("next")}
                      <span>Play next</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playLast(albumQueueItems(artist, album))}
                    >
                      {@render icon("plus")}
                      <span>Play last</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => downloadAlbum(artist, album)}
                    >
                      {@render icon("download")}
                      <span>Download</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    class="button"
                    data-variant="neutral"

                  >Cancel</button>
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
            {connectedHost ? "Artist not found." : "Connect your library."}
          </p>
          <a
            class="button"
            data-size="md"
            data-variant="neutral"
            href={router.href(connectedHost ? "/library" : "/settings")}
            >{connectedHost ? "Open library" : "Open settings"}</a
          >
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
        ? tracksFor(album).filter(
            (track) => trackEngine.getStatus(track.id) === "downloaded",
          )
        : tracksFor(album)
      : []}

    <header class="topbar track-list">
      <a
        class="icon-button"
        data-size="md"
        data-variant="neutral"
        href={artist
          ? router.href(artistPath(artist))
          : router.href("/library")}
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

    <section
      class="view library-view"
      use:scanLibrarySelection={{ artist, album }}
    >
      {#if connectedHost && !error && artist && album}
        {@const artwork = coverEngine.getCover({
          candidates: albumCoverArts(album),
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
            <span class="type-eyebrow muted">{artist.name}</span>
            <h2 class="type-heading">{album.name}</h2>
            <p class="library-meta type-small">
              {artist.name} · {album.year ?? "Unknown year"} · {visibleTracks.length}
              track{visibleTracks.length === 1 ? "" : "s"}
            </p>
            {#if albumGenres(album).length > 0}
              <div class="genre-list">
                {#each albumGenres(album) as genre}<span class="type-caption"
                    >{genre}</span
                  >{/each}
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
            title={`Open menu for ${album.name}`}
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
              <strong id="album-page-menu-title" class="type-title">{album.name}</strong>
            </header>
            <div class="track-list">
              <button
                type="button"
                class="track-item action-menu-item"

                onclick={() => playAlbum(artist, album)}
              >
                {@render icon("play")}
                <span>Play</span>
              </button>
              <button
                type="button"
                class="track-item action-menu-item"

                onclick={() => playNext(albumQueueItems(artist, album))}
              >
                {@render icon("next")}
                <span>Play next</span>
              </button>
              <button
                type="button"
                class="track-item action-menu-item"

                onclick={() => playLast(albumQueueItems(artist, album))}
              >
                {@render icon("plus")}
                <span>Play last</span>
              </button>
              <button
                type="button"
                class="track-item action-menu-item"

                onclick={() => downloadAlbum(artist, album)}
              >
                {@render icon("download")}
                <span>Download</span>
              </button>
            </div>
            <button
              type="button"
              class="button"
              data-variant="neutral"

            >Cancel</button>
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
              <div class="track-item">
                <span class="track-leading">{track.track ?? index + 1}</span>
                <button
                  type="button"
                  class="track-content"
                  onclick={() => playTrack(artist, album, track)}
                >
                  <span>{track.title}</span>
                </button>
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
                    <strong id={`${trackMenuId}-title`} class="type-title">{track.title}</strong>
                  </header>
                  <div class="track-list">
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playTrack(artist, album, track)}
                    >
                      {@render icon("play")}
                      <span>Play</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playNext([trackQueueItem(artist, album, track)])}
                    >
                      {@render icon("next")}
                      <span>Play next</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => playLast([trackQueueItem(artist, album, track)])}
                    >
                      {@render icon("plus")}
                      <span>Play last</span>
                    </button>
                    <button
                      type="button"
                      class="track-item action-menu-item"

                      onclick={() => downloadLibraryTrack(artist, album, track)}
                    >
                      {@render icon("download")}
                      <span>Download</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    class="button"
                    data-variant="neutral"

                  >Cancel</button>
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
            {connectedHost ? "Album not found." : "Connect your library."}
          </p>
          <a
            class="button"
            data-size="md"
            data-variant="neutral"
            href={router.href(connectedHost ? "/library" : "/settings")}
            >{connectedHost ? "Open library" : "Open settings"}</a
          >
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

  <Router
    routes={[
      { pattern: "/library", render: libraryRoute },
      {
        pattern: "/library/artist/:artistId/album/:albumId",
        render: albumRoute,
      },
      { pattern: "/library/artist/:artistId", render: artistRoute },
      { pattern: "/settings", render: settingsRoute },
    ]}
    bind:navigate
  />

  {@render playerDialog()}

  {#snippet miniPlayer()}
    {#if queue.length > 0}
      <div class="mini-player track-list">
        <div class="track-item">
          <button
            class="mini-main"
            type="button"
            commandfor="player-dialog"
            command="show-modal"
            title="Open player"
          >
          <span class="mini-art">
            {#if queue[currentIndex >= 0 ? currentIndex : 0].coverArt}
              {@const cover = coverEngine.getCover({
                candidates: [
                  queue[currentIndex >= 0 ? currentIndex : 0].coverArt,
                ],
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
          </span>
          <span class="mini-copy stack-xs">
            <strong class="type-title"
              >{queue[currentIndex >= 0 ? currentIndex : 0].title}</strong
            >
            <small class="type-small muted"
              >{queue[currentIndex >= 0 ? currentIndex : 0].artist}</small
            >
          </span>
          </button>
          <button
            type="button"
            class="icon-button"
            data-size="md"
            data-variant="primary"
            onclick={togglePlayback}
            title={isPlaying ? "Pause" : "Play"}
          >
          {#if playbackLoading}
            {@render icon("loading")}
          {:else if isPlaying}
            {@render icon("pause")}
          {:else}
            {@render icon("play")}
          {/if}
          </button>
        </div>
        <span class="mini-progress"
          ><span style:width={`${playbackPercent()}%`}></span></span
        >
      </div>
    {/if}
  {/snippet}
</main>

<PwaUpdate />
