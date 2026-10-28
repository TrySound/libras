<script lang="ts">
  import Icon from "./icon.svelte";
  import { onDestroy, onMount, untrack, type Snippet } from "svelte";
  import { installLongPress } from "./long-press";
  import { Playback } from "./playback.svelte";
  import { Playlists } from "./playlists.svelte";
  import AudioPlayer from "./audio-player.svelte";
  import Player from "./ui/player.svelte";
  import Atmosphere from "./ui/atmosphere.svelte";
  import Loader from "./ui/loader.svelte";
  import Downloads from "./_downloads.svelte";
  import Settings from "./_settings.svelte";
  import AlbumRoute from "./_album.svelte";
  import ArtistRoute from "./_artist.svelte";
  import LibraryRoute from "./_library.svelte";
  import SearchRoute, { createSearchState } from "./_search.svelte";
  import type WebappUpdater from "./webapp-updater.svelte";
  import type { AuthStore } from "./auth";
  import { Covers } from "./covers.svelte";
  import { Cache } from "./cache.svelte";
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
    settingsContent?: Snippet;
  }

  // Entry points explicitly supply infrastructure; UI and domain state belong to App.
  let {
    network,
    auth,
    updaterComponent: Updater,
    embedded = false,
    settingsContent,
  }: Props = $props();

  let navigationDrawer: HTMLDialogElement;
  let navigationOpen = $state(false);

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
  const hasNextTrack = $derived(
    cache.queue.index >= 0 && cache.queue.index < cache.queue.tracks.length - 1,
  );
  const hasPreviousTrack = $derived(cache.queue.index > 0);
  const covers = new Covers(selection);
  const playlists = new Playlists(selection);
  const trackEngine = new TrackEngine({ selection });
  let player = $state<ReturnType<typeof AudioPlayer>>();
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
</script>

<AudioPlayer
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
  <Atmosphere />
  <Settings {session}>
    {@render settingsContent?.()}
  </Settings>
{/snippet}

{#snippet downloadsRoute()}
  <Atmosphere />
  <Downloads {cache} {covers} {trackEngine} {loading} />
{/snippet}

{#snippet libraryRoute()}
  <Atmosphere />
  <LibraryRoute {cache} {covers} {trackEngine} {session} {playback} />
{/snippet}

{#snippet searchRoute()}
  <Atmosphere />
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
    <Icon name="brand" size="lg" color="var(--accent)" />
    <span class="brand uppercase">Libras</span>
  </a>
{/snippet}

{#snippet navigation()}
  <nav class="stack-sm" aria-label="Main navigation">
    <a
      class="menu-item"
      href="#/library"
      aria-current={isCurrentPage("/library") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="disc" color={isCurrentPage("/library") ? "var(--accent)" : undefined} />
      Your library
    </a>
    <a
      class="menu-item"
      href="#/search"
      aria-current={isCurrentPage("/search") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="search" color={isCurrentPage("/search") ? "var(--accent)" : undefined} />
      Search
    </a>
    <a
      class="menu-item"
      href="#/downloads"
      aria-current={isCurrentPage("/downloads") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="download" color={isCurrentPage("/downloads") ? "var(--accent)" : undefined} />
      Downloads
    </a>
    <a
      class="menu-item"
      href="#/settings"
      aria-current={isCurrentPage("/settings") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="settings" color={isCurrentPage("/settings") ? "var(--accent)" : undefined} />
      Settings
    </a>
  </nav>
  {#if appUpdate?.message}
    <hr class="separator" />
    <section class="stack-sm" aria-label="App update">
      {#if appUpdate.hasUpdate}
        <button
          class="menu-item"
          aria-disabled={appUpdate.busy}
          aria-busy={appUpdate.busy}
          title={appUpdate.failed ? undefined : appUpdate.message}
          onclick={() => void updater?.update()}
        >
          {#if appUpdate.busy}
            <Loader />
          {:else}
            <Icon name="refresh" color="var(--text-subtle)" />
          {/if}
          <span class="label text-subtle">{appUpdate.busy ? "Updating…" : "Update Libras"}</span>
        </button>
      {/if}
      {#if appUpdate.failed}
        <p class="caption text-subtle">{appUpdate.message}</p>
      {/if}
    </section>
  {/if}
{/snippet}

<div class="app-root" class:standalone={!embedded}>
  <div class="app-shell" data-embedded={embedded || undefined}>
    <div class="app-stage">
      {#snippet actions()}
        {#if hasErrors}
          <button
            class="button"
            data-variant="ghost"
            commandfor="error-popover"
            command="toggle-popover"
            aria-label="Show errors"
            title="Show errors"
          >
            <Icon name="error" color="var(--error-text)" />
          </button>
        {/if}
      {/snippet}
      <aside class="sidebar app-sidebar stack-lg" aria-label="Navigation">
        {@render brand()}
        {@render navigation()}
      </aside>
      <header class="topbar app-header row-md row-justify row-wrap">
        {@render brand()}
        <div class="row-sm">
          {@render actions()}
          <a class="button" href="#/search" aria-label="Search">
            <Icon name="search" />
          </a>
          <button
            class="button"
            data-size={appUpdate?.hasUpdate ? "text" : undefined}
            data-variant={appUpdate?.hasUpdate ? "secondary" : undefined}
            aria-label="Open menu"
            aria-describedby={appUpdate?.hasUpdate ? "navigation-update-hint" : undefined}
            aria-controls="navigation-dialog"
            aria-expanded={navigationOpen}
            commandfor="navigation-dialog"
            command="show-modal"
          >
            {#if appUpdate?.hasUpdate}
              <span id="navigation-update-hint" class="caption text-subtle">Update</span>
            {/if}
            <Icon name="menu-lines" />
          </button>
        </div>
      </header>
      {#if hasErrors}
        <div class="row-sm app-status-actions">{@render actions()}</div>
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
      <Player {cache} {covers} {playback} {trackEngine} {offlineMode} audio={player} />
      {#if hasErrors}
        <div id="error-popover" class="notification-popover" popover="auto" aria-label="Errors">
          <div class="stack-sm">
            {#each alerts as alert (alert.id)}
              {#if alert.message}
                <p class="card caption" role="alert">{alert.message}</p>
              {/if}
            {/each}
          </div>
          <button
            class="button"
            data-variant="ghost"
            aria-label="Close errors"
            commandfor="error-popover"
            command="hide-popover"
          >
            <Icon name="cross" />
          </button>
        </div>
      {/if}
      <dialog
        class="right-sheet"
        id="navigation-dialog"
        data-swiperight="close"
        aria-label="Navigation"
        closedby="any"
        bind:this={navigationDrawer}
        ontoggle={() => {
          navigationOpen = navigationDrawer.open;
        }}
      >
        <span class="dialog-handle" data-side="left" aria-hidden="true"></span>
        <div class="stack-lg">
          <header class="row-md row-justify">
            {@render brand()}
            <button
              class="button"
              aria-label="Close menu"
              commandfor="navigation-dialog"
              command="close"
            >
              <Icon name="cross" />
            </button>
          </header>
          {@render navigation()}
        </div>
      </dialog>
    </div>
  </div>

  {#if Updater}
    <Updater bind:this={updater} />
  {/if}
</div>
