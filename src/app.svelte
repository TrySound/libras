<script lang="ts">
  import Icon, { type IconName } from "./icon.svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import { installLongPress } from "./long-press";
  import { Playback } from "./playback.svelte";
  import { Playlists } from "./playlists.svelte";
  import Player from "./player.svelte";
  import Downloads from "./_downloads.svelte";
  import Settings from "./_settings.svelte";
  import AlbumRoute from "./_album.svelte";
  import ArtistRoute from "./_artist.svelte";
  import LibraryRoute from "./_library.svelte";
  import SearchRoute, { createSearchState } from "./_search.svelte";
  import type WebappUpdater from "./webapp-updater.svelte";
  import type { AuthStore } from "./auth";
  import { Covers } from "./covers.svelte";
  import Artwork from "./artwork.svelte";
  import type { Album as AlbumRecord, Artist as ArtistRecord } from "./schema";
  import { Cache, type Immutable } from "./cache.svelte";
  import { Session } from "./session.svelte";
  import type { Network } from "./network.svelte";
  import Router, { isCurrentPage, navigate, type RouteParams } from "./router.svelte";
  import { TrackEngine } from "./track.svelte";
  import { installSwipeToDismiss } from "./swipe-to-dismiss";

  interface Props {
    network: Network;
    auth: AuthStore;
    updaterComponent: typeof WebappUpdater | undefined;
    embedded?: boolean;
  }

  // Entry points explicitly supply infrastructure; UI and domain state belong to App.
  let { network, auth, updaterComponent: Updater, embedded = false }: Props = $props();

  const navigationLinks: { path: string; label: string; icon: IconName }[] = [
    { path: "/library", label: "Your library", icon: "disc" },
    { path: "/search", label: "Search", icon: "search" },
    { path: "/downloads", label: "Downloads", icon: "download" },
    { path: "/settings", label: "Settings", icon: "settings" },
  ];
  let navigationDrawer: HTMLDialogElement;
  let navigationOpen = $state(false);

  const durationFormatter = new Intl.DurationFormat("en", {
    minutes: "numeric",
    seconds: "2-digit",
  });

  function formatTime(value: number) {
    const seconds = Number.isFinite(value) ? Math.floor(value) : 0;
    return durationFormatter.format({
      minutes: Math.floor(seconds / 60),
      seconds: seconds % 60,
    });
  }

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
  const playerArtist = $derived(currentTrack && cache.artists.get(currentTrack.artistIds[0]));
  const playerAlbum = $derived(currentTrack && cache.albums.get(currentTrack.albumId));
  const playerAlbumArtist = $derived(playerAlbum && cache.artists.get(playerAlbum.artistIds[0]));
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
  const playlists = new Playlists(selection);
  const trackEngine = new TrackEngine({ selection });
  let player = $state<ReturnType<typeof Player>>();
  const playback: Playback = new Playback({
    selection,
    tracks: trackEngine,
    covers,
    isAvailable: (id) => !offlineMode || trackEngine.getStatus(id) === "downloaded",
  });
  const session = untrack(
    () =>
      new Session({
        selection,
        network,
        auth,
        covers,
        tracks: trackEngine,
        playback,
        playlists,
        preferences: auth.storage,
      }),
  );
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
    playlists.destroy();
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

{#snippet settingsRoute()}
  <Settings {session} />
{/snippet}

{#snippet downloadsRoute()}
  <Downloads {cache} {covers} {trackEngine} {loading} />
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

{#snippet brand()}
  <a
    class="button-quiet row-sm"
    href="#/library"
    aria-label="Libras home"
    onclick={() => navigationDrawer?.close()}
  >
    <Icon name="brand" size={32} color="var(--accent)" />
    <span class="brand uppercase">Libras</span>
  </a>
{/snippet}

{#snippet navigation()}
  <nav class="stack-sm" aria-label="Main navigation">
    {#each navigationLinks as link}
      <a
        class="menu-item"
        href={`#${link.path}`}
        title={link.label}
        aria-label={link.label}
        aria-current={isCurrentPage(link.path) ? "page" : undefined}
        onclick={() => navigationDrawer?.close()}
      >
        <Icon
          name={link.icon}
          size={24}
          color={isCurrentPage(link.path) ? "var(--accent)" : undefined}
        />
        {link.label}
      </a>
    {/each}
  </nav>
{/snippet}

<div class="app-root" class:standalone={!embedded}>
  <div class="app-shell" data-embedded={embedded || undefined}>
    {#snippet actions()}
      {#if hasErrors}
        <button
          class="button"
          data-size="md"
          data-variant="ghost"
          commandfor="error-popover"
          command="toggle-popover"
          aria-label="Show errors"
          title="Show errors"
        >
          <Icon name="error" color="var(--error-text)" />
        </button>
      {/if}
      {#if appUpdate?.message}
        <button
          class="button"
          data-size="md"
          data-variant="ghost"
          commandfor="update-popover"
          command="toggle-popover"
          aria-label="App update"
          title="App update"
        >
          <Icon name={appUpdate.busy ? "loading" : "refresh"} />
        </button>
      {/if}
    {/snippet}
    <aside class="sidebar app-sidebar stack-lg ui-edgerunner" aria-label="Navigation">
      {@render brand()}
      {@render navigation()}
    </aside>
    <header class="topbar app-header row-md row-justify row-wrap ui-edgerunner">
      {@render brand()}
      <div class="row-sm">
        {@render actions()}
        <a class="button" href="#/search" aria-label="Search"><Icon name="search" size={24} /></a>
        <button
          class="button"
          aria-label="Open menu"
          aria-controls="navigation-dialog"
          aria-expanded={navigationOpen}
          commandfor="navigation-dialog"
          command="show-modal"><Icon name="menu-lines" size={24} /></button
        >
      </div>
    </header>
    {#if hasErrors || appUpdate?.message}
      <div class="row-sm app-status-actions ui-edgerunner">{@render actions()}</div>
    {/if}
    <main class="app-page">
      <Router
        {embedded}
        routes={[
          { pattern: "/library", render: libraryRoute },
          { pattern: "/search", render: searchRoute },
          { pattern: "/library/artist/:artistId/album/:albumId", render: albumRoute },
          { pattern: "/library/artist/:artistId", render: artistRoute },
          { pattern: "/settings", render: settingsRoute },
          { pattern: "/downloads", render: downloadsRoute },
        ]}
      />
    </main>
    {#if currentTrack}
      <div class="app-player">
        <div class="mini-player wings">
          <button
            class="linkarea"
            commandfor="player-dialog"
            command="show-modal"
            aria-label="Open player"
          ></button>
          <Artwork {covers} id={currentTrack.artworkId} size="sm" loading="eager" />
          <span class="mini-copy stack-xs">
            <strong class="type-title truncate">
              {currentTrack.title}
            </strong>
            <small class="type-small text-muted truncate">
              {currentTrack.displayArtist ?? cache.artists.get(currentTrack.artistIds[0])?.name}
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
              <Icon name="loading" />
            {:else if player?.playing}
              <Icon name="pause" />
            {:else}
              <Icon name="play" />
            {/if}
          </button>
          <span class="mini-progress">
            <span style:width={`${playbackPercent()}%`}></span>
          </span>
        </div>
      </div>
    {/if}
    {#if hasErrors}
      <div
        id="error-popover"
        class="ui-edgerunner notification-popover"
        popover="auto"
        aria-label="Errors"
      >
        <div class="stack-sm">
          {#each alerts as alert (alert.id)}
            {#if alert.message}
              <p class="card caption" role="alert">{alert.message}</p>
            {/if}
          {/each}
        </div>
        <button
          class="button"
          data-size="sm"
          data-variant="ghost"
          aria-label="Close errors"
          commandfor="error-popover"
          command="hide-popover"><Icon name="cross" /></button
        >
      </div>
    {/if}
    {#if appUpdate?.message}
      <div
        id="update-popover"
        class="ui-edgerunner notification-popover"
        popover="auto"
        aria-label="App update"
      >
        <div class="stack-sm">
          <strong class="heading-md">App update</strong>
          <p class="caption">{appUpdate.message}</p>
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
          class="button"
          data-size="sm"
          data-variant="ghost"
          aria-label="Close app update"
          commandfor="update-popover"
          command="hide-popover"><Icon name="cross" /></button
        >
      </div>
    {/if}
    <dialog
      class="right-sheet ui-edgerunner"
      id="navigation-dialog"
      aria-label="Navigation"
      closedby="any"
      bind:this={navigationDrawer}
      ontoggle={() => {
        navigationOpen = navigationDrawer.open;
      }}
    >
      <div class="stack-lg">
        <header class="row-md row-justify">
          {@render brand()}
          <button
            class="button"
            aria-label="Close menu"
            commandfor="navigation-dialog"
            command="close"><Icon name="cross" size={24} /></button
          >
        </header>
        {@render navigation()}
      </div>
    </dialog>
  </div>

  <dialog id="player-dialog" class="player-dialog" closedby="any" data-swipedown="close">
    <header class="topbar wings">
      <button
        class="icon-button"
        data-size="md"
        data-variant="ghost"
        commandfor="player-dialog"
        command="close"
        title="Close player"><Icon name="chevron-down" /></button
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
                  {currentTrack.displayArtist ?? playerArtist.name}
                </a>
              {:else}
                {currentTrack.displayArtist}
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
            {#if currentTrack.genres.length > 0}
              <div class="row-wrap-sm">
                {#each currentTrack.genres as genre}
                  <span class="chip type-caption">{genre}</span>
                {/each}
              </div>
            {/if}
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
              title="Previous"><Icon name="previous" /></button
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
                <Icon name="loading" size="lg" />
              {:else if player?.playing}
                <Icon name="pause" size="lg" />
              {:else}
                <Icon name="play" size="lg" />
              {/if}
            </button>
            <button
              class="icon-button"
              data-size="md"
              data-variant="neutral"
              onclick={() => playback.next()}
              disabled={!hasNextTrack}
              title="Next"><Icon name="next" /></button
            >
          </div>
        </div>
      </div>

      <div class="player-queue stack-md">
        <div class="view row-md">
          <div class="stack-xs grow">
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
              {@const credit =
                track.displayArtist?.trim() ||
                track.artistIds
                  .map((id) => cache.artists.get(id)?.name)
                  .filter(Boolean)
                  .join(", ")}
              <div class="wings-item row-button">
                <button
                  class="linkarea"
                  aria-label={`Play ${track.title}`}
                  onclick={() => playback.playIndex(index)}
                ></button>
                <span class="track-leading">
                  {#if index === cache.queue.index && playbackLoading}
                    <span role="img" aria-label="Loading playback">
                      <Icon name="loading" />
                    </span>
                  {:else if index === cache.queue.index && player?.playing}
                    <span role="img" aria-label="Playing">
                      <Icon name="sound-bars" />
                    </span>
                  {:else if index === cache.queue.index}
                    <span role="img" aria-label="Current track, not playing">
                      <Icon name="pause" />
                    </span>
                  {:else if downloadStatus === "downloading"}
                    <span role="img" aria-label="Downloading">
                      <Icon name="loading" />
                    </span>
                  {:else if downloadStatus === "queued"}
                    <span role="img" aria-label="Queued for download">
                      <Icon name="clock" />
                    </span>
                  {:else}
                    {String(visibleIndex + 1).padStart(2, "0")}
                  {/if}
                </span>
                <span class="stack-xs grow">
                  <span class="truncate">{track.title}</span>
                  {#if credit}
                    <small class="type-small text-muted truncate">{credit}</small>
                  {/if}
                </span>
                {#if track.duration !== undefined}
                  <span class="type-small text-muted text-right">{formatTime(track.duration)}</span>
                {/if}
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

  {#if Updater}
    <Updater bind:this={updater} />
  {/if}
</div>
