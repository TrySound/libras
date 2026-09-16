<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { installLongPress } from "./long-press";
  import { Playback } from "./playback.svelte";
  import Player from "./player.svelte";
  import Downloads from "./_downloads.svelte";
  import Settings from "./_settings.svelte";
  import AlbumRoute from "./_album.svelte";
  import ArtistRoute from "./_artist.svelte";
  import LibraryRoute from "./_library.svelte";
  import SearchRoute, { createSearchState } from "./_search.svelte";
  import WebappUpdater from "./webapp-updater.svelte";
  import { AuthStore } from "./auth";
  import { Covers } from "./covers.svelte";
  import Artwork from "./artwork.svelte";
  import type { Album as AlbumRecord, Artist as ArtistRecord } from "./schema";
  import { Cache, type Immutable } from "./cache.svelte";
  import { Session } from "./session.svelte";
  import { Network } from "./network.svelte";
  import Router, { navigate, type RouteParams } from "./router.svelte";
  import { TrackEngine } from "./track.svelte";
  import { installSwipeToDismiss } from "./swipe-to-dismiss";

  type Album = Immutable<AlbumRecord>;
  type Artist = Immutable<ArtistRecord>;

  let updater = $state<ReturnType<typeof WebappUpdater>>();
  const appUpdate = $derived(updater?.getStatus());

  const selection = $state<{ cache: Cache | undefined }>({ cache: undefined });
  const emptyCache = new Cache();
  const cache = $derived(selection.cache ?? emptyCache);
  function newSearchState() {
    const state = $state(createSearchState());
    return state;
  }
  // Owned above the route so Back retains state; cache switches discard it.
  const searchState = $derived.by(() => {
    void cache;
    return newSearchState();
  });
  const currentTrack = $derived(cache.tracks.get(cache.queue.tracks[cache.queue.index]));
  const playerArtist = $derived(currentTrack && cache.artists.get(currentTrack.artistId));
  const playerAlbum = $derived(currentTrack && cache.albums.get(currentTrack.albumId));
  const playerAlbumArtist = $derived(playerAlbum && cache.artists.get(playerAlbum.artistId));
  const hasNextTrack = $derived(
    cache.queue.index >= 0 && cache.queue.index < cache.queue.tracks.length - 1,
  );
  const hasPreviousTrack = $derived(cache.queue.index > 0);
  let queue = $derived(
    cache.queue.tracks.flatMap((id, index) => {
      const track = cache.tracks.get(id);
      return track && (!offlineMode || trackEngine.getStatus(id) === "downloaded")
        ? [{ track, index }]
        : [];
    }),
  );
  const covers = new Covers(selection);
  const trackEngine = new TrackEngine({ selection });
  let player = $state<ReturnType<typeof Player>>();
  const playback: Playback = new Playback({
    selection,
    tracks: trackEngine,
    covers,
    isAvailable: (id) => !offlineMode || trackEngine.getStatus(id) === "downloaded",
  });
  const network = new Network();
  const session = new Session({
    selection,
    network,
    auth: new AuthStore(),
    covers,
    tracks: trackEngine,
    playback,
    preferences: localStorage,
  });
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
  onMount(() => installSwipeToDismiss());
  onMount(() => playback.attach(player!));

  onDestroy(() => {
    session.destroy();
    playback.destroy();
    covers.destroy();
    trackEngine.destroy();
  });

  onMount(() => {
    const savedAuth = session.start();
    if (!savedAuth && cache.key === undefined) navigate("/settings", "replace");
  });

  function artistPath(artist: Artist) {
    return `/library/artist/${encodeURIComponent(artist.id)}`;
  }

  function albumPath(artist: Artist, album: Album) {
    return `${artistPath(artist)}/album/${encodeURIComponent(album.id)}`;
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
  onstatechange={(state) => playback.updatePlayerState(state)}
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
  <LibraryRoute {cache} {covers} {trackEngine} {session} {playback} />
{/snippet}

{#snippet searchRoute()}
  <SearchRoute {cache} {covers} {trackEngine} {session} {playback} state={searchState} />
{/snippet}

{#snippet artistRoute(params: RouteParams)}
  <ArtistRoute {params} {cache} {covers} {trackEngine} {session} {playback} />
{/snippet}

{#snippet albumRoute(params: RouteParams)}
  <AlbumRoute
    {params}
    {cache}
    {covers}
    {trackEngine}
    {session}
    {playback}
    playbackState={playbackLoading ? "loading" : player?.playing ? "playing" : "paused"}
  />
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
      { pattern: "/search", render: searchRoute },
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
  <div class="mini-player wings">
    <button
      class="linkarea"
      commandfor="player-dialog"
      command="show-modal"
      aria-label="Open player"
    ></button>
    <Artwork {covers} id={currentTrack.artworkId} size="sm" loading="eager" />
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

<dialog id="player-dialog" class="player-dialog" closedby="any" data-swipedown="close">
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

  <section class="player-view">
    <div class="player-main">
      <Artwork {covers} id={currentTrack?.artworkId} size="stretch" loading="eager" />

      <div class="view player-content">
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
    </div>

    <div class="player-queue">
      <div class="view section-heading">
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
        <p class="view type-body text-muted">No available tracks.</p>
      {:else}
        <p class="view type-body text-muted">The queue is empty.</p>
      {/if}
    </div>
  </section>
</dialog>

<WebappUpdater bind:this={updater} />
