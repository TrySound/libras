<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { installLongPress } from "./long-press";
  import { PlaybackController } from "./playback-controller.svelte";
  import Player from "./player.svelte";
  import Downloads from "./_downloads.svelte";
  import Settings from "./_settings.svelte";
  import AlbumRoute from "./_album.svelte";
  import ArtistRoute from "./_artist.svelte";
  import WebappUpdater from "./webapp-updater.svelte";
  import { AuthStore } from "./auth";
  import { CoverEngine, immediateCover } from "./cover.svelte";
  import { viewportContent } from "./viewport";
  import { MetadataEngine } from "./metadata.svelte";
  import type {
    Album as AlbumRecord,
    Artist as ArtistRecord,
    Track as TrackRecord,
  } from "./schema";
  import { Cache, type Immutable } from "./cache.svelte";
  import { QueueEngine } from "./queue.svelte";
  import { Session } from "./session.svelte";
  import { Network } from "./network.svelte";
  import Router, { navigate, type RouteParams } from "./router.svelte";
  import { TrackEngine } from "./track.svelte";
  import { swipeToDismiss } from "./swipe-to-dismiss";

  type Album = Immutable<AlbumRecord>;
  type Artist = Immutable<ArtistRecord>;
  type Track = Immutable<TrackRecord>;

  let updater = $state<ReturnType<typeof WebappUpdater>>();
  const appUpdate = $derived(updater?.getStatus());

  const selection = $state<{ cache: Cache | undefined }>({ cache: undefined });
  const emptyCache = new Cache();
  const cache = $derived(selection.cache ?? emptyCache);
  const currentTrack = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const playerArtist = $derived(currentTrack && cache.artists.get(currentTrack.artistId));
  const playerAlbum = $derived(currentTrack && cache.albums.get(currentTrack.albumId));
  const playerAlbumArtist = $derived(playerAlbum && cache.artists.get(playerAlbum.artistId));
  const hasNextTrack = $derived(
    cache.queue.index >= 0 && cache.queue.index < cache.queue.tracks.length - 1,
  );
  const hasPreviousTrack = $derived(cache.queue.index > 0);
  const metadataEngine = new MetadataEngine(selection);
  const queueEngine = new QueueEngine(selection);
  let artists = $derived([...cache.artists.values()]);
  let queue = $derived(
    cache.queue.tracks.flatMap((id, index) => {
      const track = cache.tracks.get(id);
      return track && (!offlineMode || trackEngine.getStatus(id) === "downloaded")
        ? [{ track, index }]
        : [];
    }),
  );
  const coverEngine = new CoverEngine(selection);
  const trackEngine = new TrackEngine({ selection });
  let player = $state<ReturnType<typeof Player>>();
  const playback: PlaybackController = new PlaybackController({
    queue: queueEngine,
    selection,
    tracks: trackEngine,
    covers: coverEngine,
    isAvailable: (id) => !offlineMode || trackEngine.getStatus(id) === "downloaded",
  });
  const network = new Network();
  const session = new Session({
    selection,
    network,
    auth: new AuthStore(),
    metadata: metadataEngine,
    queue: queueEngine,
    covers: coverEngine,
    tracks: trackEngine,
    playback,
    preferences: localStorage,
  });
  const libraryAvailable = $derived(cache.savedAt !== undefined);
  const offlineMode = $derived(session.offlineMode);
  const error = $derived(session.error);
  const refreshError = $derived(session.refreshError);
  const playbackDuration = $derived(player?.duration || currentTrack?.duration || 0);
  let playbackLoading = $derived(
    ["loading", "buffering", "seeking"].includes(player?.status ?? "idle"),
  );
  let playbackError = $derived(
    player?.error instanceof Error
      ? player.error.message
      : player?.error
        ? String(player.error)
        : "",
  );
  let loading = $derived(!session.localReady);
  const alerts = $derived([
    { id: "session", message: error },
    {
      id: "refresh",
      message: refreshError ? `${refreshError} Your existing library is still available.` : "",
    },
    {
      id: "tracks",
      message: trackEngine.error
        ? trackEngine.error instanceof Error
          ? trackEngine.error.message
          : String(trackEngine.error)
        : "",
    },
    { id: "playback", message: playbackError },
  ]);
  const hasErrors = $derived(alerts.some((alert) => alert.message));

  onMount(() => installLongPress());
  onMount(() => playback.attach(player!));

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
    if (!savedAuth && !cache.account) navigate("/settings", "replace");
  });

  function artistPath(artist: Artist) {
    return `/library/artist/${encodeURIComponent(artist.id)}`;
  }

  function albumPath(artist: Artist, album: Album) {
    return `${artistPath(artist)}/album/${encodeURIComponent(album.id)}`;
  }

  function artistTracks(artist: Artist): readonly Track[] {
    return (cache.artistAlbums.get(artist.id) ?? []).flatMap(
      (album) => cache.albumTracks.get(album.id) ?? [],
    );
  }

  function availableTracks(items: readonly Track[]) {
    return offlineMode
      ? items.filter((track) => trackEngine.getStatus(track.id) === "downloaded")
      : items;
  }

  function availableTrackIds(tracks: readonly Track[]) {
    return availableTracks(tracks).map((track) => track.id);
  }

  function playArtist(artist: Artist) {
    void playback.replaceQueueAndPlay(availableTrackIds(artistTracks(artist)));
  }

  function playNext(tracks: readonly Track[]) {
    void playback.enqueue(availableTrackIds(tracks), "next");
  }

  function playLast(tracks: readonly Track[]) {
    void playback.enqueue(availableTrackIds(tracks), "last");
  }

  async function downloadTrack(track: Track) {
    try {
      const album = cache.albums.get(track.albumId);
      await trackEngine.cache({
        id: track.id,
        title: track.title,
        artist: track.artistName ?? cache.artists.get(track.artistId)?.name,
        album: album?.title,
        contentType: track.mimeType,
      });
    } catch {
      // TrackEngine exposes download failures through its error state.
    }
  }

  function downloadCollection(tracks: readonly Track[]) {
    return Promise.all(tracks.map(downloadTrack));
  }

  function downloadArtist(artist: Artist) {
    return downloadCollection(artistTracks(artist));
  }

  function playbackPercent() {
    if (!Number.isFinite(playbackDuration) || playbackDuration <= 0) return 0;
    return Math.min(100, Math.max(0, (cache.queue.position / playbackDuration) * 100));
  }

  function formatTime(value: number) {
    if (!Number.isFinite(value)) return "0:00";
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
</script>

<Player
  bind:this={player}
  hasPrevious={hasPreviousTrack || (cache.queue.index >= 0 && cache.queue.position > 0)}
  hasNext={hasNextTrack}
  onprevious={() => playback.previous()}
  onnext={() => playback.next()}
  onposition={(position) => playback.setPosition(position)}
  onended={() => playback.ended()}
/>

<svelte:head>
  <title>Libras</title>
</svelte:head>

{#snippet icon(name: string, size = 20, className = "")}
  <svg class={className} aria-hidden="true" width={size} height={size}>
    <use href={`#icon-${name}`}></use>
  </svg>
{/snippet}

{#snippet brand()}
  <div class="topbar-brand">
    <a
      class="icon-button"
      data-variant="ghost"
      href="#/library"
      aria-label="Libras home"
      title="Home"
    >
      <svg
        role="img"
        aria-label="Libras"
        width="32"
        height="32"
        viewBox="0 0 256 256"
        fill="currentColor"
      >
        <use href="#icon-brand"></use>
      </svg>
    </a>
  </div>
{/snippet}

{#snippet settingsRoute()}
  <Settings {session} />
{/snippet}

{#snippet downloadsRoute()}
  <Downloads {cache} {trackEngine} {loading} />
{/snippet}

{#snippet libraryRoute()}
  {@const visibleArtists = offlineMode
    ? artists.filter((artist) =>
        artistTracks(artist).some((track) => trackEngine.getStatus(track.id) === "downloaded"),
      )
    : artists}

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

      {#if loading}
        <div class="empty-state">
          <div class="scan-spinner">{@render icon("loading")}</div>
          <p class="type-body">Restoring local library…</p>
        </div>
      {/if}
      {#if visibleArtists.length > 0}
        <div class="tiles-grid">
          {#each visibleArtists as artist, index}
            {@const menuId = `artist-menu-${index}`}
            {@const cover = coverEngine.ensureArtistCover(artist.id)}
            <a
              class="tile"
              {@attach viewportContent(cover.load)}
              aria-label={artist.name}
              href={`#${artistPath(artist)}`}
              data-longpressfor={menuId}
              data-longpress="show-modal"
              title={`${artist.name} — hold for actions`}
            >
              <span
                class="tile-image"
                style:view-transition-name={CSS.escape(`artist-cover-${artist.id}`)}
              >
                {#if cover.source}
                  <img src={cover.source} alt="" />
                {:else}
                  <span>{@render icon("music")}</span>
                {/if}
                <strong
                  class="tile-name type-small"
                  style:view-transition-name={CSS.escape(`artist-name-${artist.id}`)}
                  >{artist.name}</strong
                >
              </span>
            </a>
          {/each}
        </div>
      {:else if !loading}
        <div class="empty-state">
          <span>{@render icon("music")}</span>
          <p class="type-body">
            {offlineMode ? "No downloaded artists." : "No artists found."}
          </p>
        </div>
      {/if}
    {:else if !loading}
      {@render connectLibrary()}
    {/if}
  </section>
  {#if libraryAvailable}
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
{/snippet}

{#snippet artistRoute(params: RouteParams)}
  <ArtistRoute {params} {cache} {coverEngine} {trackEngine} {session} {playback} />
{/snippet}

{#snippet albumRoute(params: RouteParams)}
  <AlbumRoute
    {params}
    {cache}
    {coverEngine}
    {trackEngine}
    {session}
    {playback}
    playbackState={playbackLoading ? "loading" : player?.playing ? "playing" : "paused"}
  />
{/snippet}

{#snippet connectLibrary()}
  <div class="empty-state">
    <span>{@render icon("music")}</span>
    <h2 class="type-heading">Connect your library</h2>
    <p class="type-body">Add your music server to start listening.</p>
    <a class="button" data-size="md" data-variant="neutral" href="#/settings">Open settings</a>
  </div>
{/snippet}

<main class="app-shell">
  <header class="topbar wings">
    {@render brand()}
    <div></div>
    <div class="row-sm">
      {#if hasErrors}
        <button
          class="icon-button"
          data-size="md"
          data-variant="ghost"
          commandfor="error-popover"
          command="toggle-popover"
          aria-label="Show errors"
          title="Show errors"
        >
          {@render icon("error", 20, "text-danger")}
        </button>
        <div id="error-popover" class="notification-popover" popover="auto" aria-label="Errors">
          <div class="stack-sm text-danger">
            {#each alerts as alert (alert.id)}
              {#if alert.message}
                <p class="type-small" role="alert">{alert.message}</p>
              {/if}
            {/each}
          </div>
          <button
            class="icon-button"
            data-size="sm"
            data-variant="ghost"
            aria-label="Close errors"
            commandfor="error-popover"
            command="hide-popover">{@render icon("cross")}</button
          >
        </div>
      {/if}
      {#if appUpdate?.message}
        <button
          class="icon-button"
          data-size="md"
          data-variant="ghost"
          commandfor="update-popover"
          command="toggle-popover"
          aria-label="App update"
          title="App update"
        >
          {@render icon(appUpdate.busy ? "loading" : "refresh")}
        </button>
        <div
          id="update-popover"
          class="notification-popover"
          popover="auto"
          aria-label="App update"
        >
          <div class="stack-sm">
            <strong class="type-title">App update</strong>
            <p class="type-small">{appUpdate.message}</p>
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
          </div>
          <button
            class="icon-button"
            data-size="sm"
            data-variant="ghost"
            aria-label="Close app update"
            commandfor="update-popover"
            command="hide-popover">{@render icon("cross")}</button
          >
        </div>
      {/if}
      <a
        class="icon-button"
        data-size="md"
        data-variant="ghost"
        href="#/settings"
        aria-label="Settings"
        title="Settings"
      >
        {@render icon("settings")}
      </a>
    </div>
  </header>
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
  />
</main>

{#if currentTrack}
  {@const cover = coverEngine.ensureTrackCover(currentTrack.id)}
  <div class="mini-player wings">
    <button
      class="linkarea"
      commandfor="player-dialog"
      command="show-modal"
      aria-label="Open player"
    ></button>
    <span class="mini-art" {@attach immediateCover(cover)}>
      {#if cover.source}
        <img src={cover.source} alt="" />
      {:else}
        <span>{@render icon("music")}</span>
      {/if}
    </span>
    <span class="mini-copy stack-xs">
      <strong class="type-title">
        {currentTrack.title}
      </strong>
      <small class="type-small text-muted">
        {currentTrack.artistName ?? cache.artists.get(currentTrack.artistId)?.name}
      </small>
    </span>
    <button
      class="icon-button"
      data-size="md"
      data-variant="primary"
      onclick={() => playback.toggle()}
      title={player?.playing ? "Pause" : "Play"}
    >
      {#if playbackLoading}
        {@render icon("loading")}
      {:else if player?.playing}
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

<dialog id="player-dialog" class="player-dialog" closedby="any" use:swipeToDismiss>
  <header class="topbar wings">
    <button
      class="icon-button"
      data-size="md"
      data-variant="ghost"
      commandfor="player-dialog"
      command="close"
      title="Close player">{@render icon("chevron-down")}</button
    >
  </header>

  <section class="view player-view">
    <div class="player-main">
      <div
        class="artwork"
        {@attach currentTrack
          ? immediateCover(coverEngine.ensureTrackCover(currentTrack.id))
          : undefined}
      >
        {#if currentTrack}
          {@const cover = coverEngine.ensureTrackCover(currentTrack.id)}
          {#if cover.source}
            <img src={cover.source} alt="" />
          {:else}
            <span>{@render icon("music", 64)}</span>
          {/if}
        {:else}
          <span>{@render icon("music", 64)}</span>
        {/if}
      </div>

      {#if currentTrack}
        <p class="type-body">
          <strong class="type-heading">{currentTrack.title}</strong>
          <br />
          {#if playerArtist}
            <a
              class="text-link"
              href={`#${artistPath(playerArtist)}`}
              onclick={(event) => event.currentTarget.closest("dialog")?.close()}
            >
              {currentTrack.artistName ?? playerArtist.name}
            </a>
          {:else}
            {currentTrack.artistName}
          {/if}
          —
          {#if playerAlbum && playerAlbumArtist}
            <a
              class="text-link"
              href={`#${albumPath(playerAlbumArtist, playerAlbum)}`}
              onclick={(event) => event.currentTarget.closest("dialog")?.close()}
            >
              {playerAlbum.title}
            </a>
          {:else}
            {playerAlbum?.title}
          {/if}
        </p>
      {/if}

      <div class="playback-progress">
        <input
          class="playback-slider"
          type="range"
          min="0"
          max={Number.isFinite(playbackDuration) ? playbackDuration : 0}
          step="0.1"
          value={Math.min(cache.queue.position, playbackDuration)}
          disabled={!playbackDuration ||
            (offlineMode &&
              currentTrack &&
              trackEngine.getStatus(currentTrack.id) !== "downloaded")}
          oninput={(event) => playback.seek(event.currentTarget.valueAsNumber)}
        />
        <div class="playback-time type-caption">
          <span>{formatTime(cache.queue.position)}</span>
          <span>{formatTime(playbackDuration)}</span>
        </div>
      </div>

      <div class="controls">
        <button
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          onclick={() => playback.previous()}
          disabled={!hasPreviousTrack && cache.queue.position <= 0}
          title="Previous">{@render icon("previous")}</button
        >
        <button
          class="icon-button"
          data-size="lg"
          data-variant="primary"
          onclick={() => playback.toggle()}
          disabled={queue.length === 0}
          title={player?.playing ? "Pause" : "Play"}
        >
          {#if playbackLoading}
            {@render icon("loading", 32)}
          {:else if player?.playing}
            {@render icon("pause", 32)}
          {:else}
            {@render icon("play", 32)}
          {/if}
        </button>
        <button
          class="icon-button"
          data-size="md"
          data-variant="neutral"
          onclick={() => playback.next()}
          disabled={!hasNextTrack}
          title="Next">{@render icon("next")}</button
        >
      </div>
    </div>

    <div class="player-queue">
      <div class="section-heading">
        <div>
          <span class="type-eyebrow text-muted">Up next</span>
          <h2 class="type-heading">
            {queue.length} track{queue.length === 1 ? "" : "s"}
          </h2>
        </div>
        {#if cache.queue.tracks.length > 0}
          <button
            class="button"
            data-size="sm"
            data-variant="neutral"
            onclick={() => playback.clearQueue()}>Clear</button
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
                {#if index === cache.queue.index && playbackLoading}
                  <span role="img" aria-label="Loading playback">
                    {@render icon("loading")}
                  </span>
                {:else if index === cache.queue.index && player?.playing}
                  <span role="img" aria-label="Playing">
                    {@render icon("sound-bars")}
                  </span>
                {:else if index === cache.queue.index}
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
      {:else if cache.queue.tracks.length > 0}
        <p class="type-body text-muted">No available tracks.</p>
      {:else}
        <p class="type-body text-muted">The queue is empty.</p>
      {/if}
    </div>
  </section>
</dialog>

<WebappUpdater bind:this={updater} />
