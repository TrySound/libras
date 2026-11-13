<script lang="ts">
  import Icon from "./icon.svelte";
  import { onDestroy, onMount, tick, untrack, type Snippet } from "svelte";
  import { installLongPress } from "./long-press";
  import { Playback } from "./playback.svelte";
  import { Playlists } from "./playlists.svelte";
  import AudioPlayer from "./audio-player.svelte";
  import { AudioTransport } from "./audio-transport.svelte";
  import Player from "./ui/player.svelte";
  import Atmosphere from "./ui/atmosphere.svelte";
  import Loader from "./ui/loader.svelte";
  import Downloads from "./_downloads.svelte";
  import Settings from "./_settings.svelte";
  import AlbumRoute from "./_album.svelte";
  import ArtistRoute from "./_artist.svelte";
  import LibraryRoute from "./_library.svelte";
  import SearchRoute from "./_search.svelte";
  import type WebappUpdater from "./webapp-updater.svelte";
  import type { AuthStore } from "./auth";
  import { Covers } from "./covers.svelte";
  import { Cache } from "./cache.svelte";
  import { Session } from "./session.svelte";
  import type { Network } from "./network.svelte";
  import Router, { isCurrentPage, type RouteParams } from "./router.svelte";
  import { TrackEngine } from "./track.svelte";
  import { installSwipeToDismiss } from "./swipe-to-dismiss";

  interface Props {
    network: Network;
    auth: AuthStore;
    updaterComponent: typeof WebappUpdater | undefined;
    settingsContent?: Snippet;
    demo?: boolean;
  }

  // Entry points explicitly supply infrastructure; UI and domain state belong to App.
  let { network, auth, updaterComponent: Updater, settingsContent, demo = false }: Props = $props();

  let navigationDrawer: HTMLDialogElement;

  let updater = $state<ReturnType<typeof WebappUpdater>>();
  const appUpdate = $derived(updater?.getStatus());

  const selection = $state<{ cache: Cache | undefined }>({ cache: undefined });
  const emptyCache = new Cache();
  const cache = $derived(selection.cache ?? emptyCache);
  const appName = $derived(demo ? "Libras demo" : "Libras");
  const hasNextTrack = $derived(
    cache.queue.index >= 0 && cache.queue.index < cache.queue.tracks.length - 1,
  );
  const hasPreviousTrack = $derived(cache.queue.index > 0);
  const covers = new Covers(selection);
  const playlists = new Playlists(selection);
  const trackEngine = new TrackEngine({ selection });
  let player = $state.raw<AudioTransport>();
  const playback: Playback = new Playback({
    selection,
    tracks: trackEngine,
    covers,
    isAvailable: (id) => !offlineMode || trackEngine.isDownloaded(id),
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
      ? player?.error.message
      : player?.error
        ? String(player?.error)
        : "",
  );
  let initialized = $state(false);
  let loading = $derived(!session.localReady);
  const alerts = $derived([
    { id: "session", message: error },
    {
      id: "refresh",
      message: refreshError ? `${refreshError} Your existing library is still available.` : "",
    },
    { id: "playback", message: playbackError },
  ]);
  const hasErrors = $derived(alerts.some((alert) => alert.message));

  onMount(() => installLongPress());
  onMount(() => installSwipeToDismiss());
  onMount(() => {
    const transport = new AudioTransport({
      onposition: (position) => playback.setPosition(position),
      onended: () => playback.ended(),
      onstatechange: (state) => playback.updatePlayerState(state),
    });
    player = transport;
    const detach = playback.attach(transport);
    return () => {
      detach();
      transport.dispose();
      player = undefined;
    };
  });

  onDestroy(() => {
    session.destroy();
    playback.destroy();
    playlists.destroy();
    covers.destroy();
    trackEngine.destroy();
  });

  onMount(() => {
    const savedAuth = session.start();
    if (!savedAuth && cache.key === undefined) {
      // Startup chooses the first page; it is not an animated navigation.
      const url = new URL(window.location.href);
      if (url.search !== "?/settings") url.hash = "";
      url.search = "/settings";
      if (url.href !== window.location.href)
        window.history.replaceState(window.history.state, "", url);
    }
    initialized = true;
  });
</script>

{#if player}
  <AudioPlayer
    transport={player}
    hasPrevious={hasPreviousTrack || (cache.queue.index >= 0 && cache.queue.position > 0)}
    hasNext={hasNextTrack}
    onprevious={() => playback.previous()}
    onnext={() => playback.next()}
  />
{/if}

{#snippet settingsRoute()}
  <Atmosphere />
  <Settings {session} {demo} {appName}>
    {@render settingsContent?.()}
  </Settings>
{/snippet}

{#snippet downloadsRoute()}
  <Atmosphere />
  <Downloads {cache} {covers} {trackEngine} {loading} {appName} />
{/snippet}

{#snippet libraryRoute()}
  <Atmosphere />
  <LibraryRoute {cache} {covers} {trackEngine} {session} {playback} {appName} />
{/snippet}

{#snippet searchRoute()}
  <Atmosphere />
  <SearchRoute {cache} {covers} {trackEngine} {session} {playback} {appName} />
{/snippet}

{#snippet artistRoute(params: RouteParams)}
  <ArtistRoute
    {params}
    {cache}
    {covers}
    {trackEngine}
    {session}
    {playback}
    {appName}
    playbackState={playbackLoading ? "loading" : player?.playing ? "playing" : "paused"}
  />
{/snippet}

{#snippet albumRoute(params: RouteParams)}
  <AlbumRoute
    {params}
    {cache}
    {covers}
    {trackEngine}
    {session}
    {playback}
    {appName}
    playbackState={playbackLoading ? "loading" : player?.playing ? "playing" : "paused"}
  />
{/snippet}

{#snippet brand()}
  <a
    class="button-quiet row-sm"
    href="?/library"
    aria-label="Libras home"
    onclick={() => navigationDrawer?.close()}
  >
    <Icon name="brand" size="lg" color="var(--accent)" />
    <span class="brand uppercase">Libras</span>
  </a>
{/snippet}

{#snippet navigation()}
  <nav class="stack-sm" aria-label="Main navigation">
    <button
      class="menu-item"
      commandfor="player-dialog"
      command="show-modal"
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="queue" />
      Queue
    </button>
    <a
      class="menu-item"
      href="?/library"
      aria-current={isCurrentPage("/library") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="disc" color={isCurrentPage("/library") ? "var(--accent)" : undefined} />
      Your library
    </a>
    <a
      class="menu-item"
      href="?/search"
      aria-current={isCurrentPage("/search") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="search" color={isCurrentPage("/search") ? "var(--accent)" : undefined} />
      Search
    </a>
    <a
      class="menu-item"
      href="?/downloads"
      aria-label={trackEngine.downloadCount
        ? `Downloads, ${trackEngine.downloadCount} active and queued files`
        : "Downloads"}
      aria-current={isCurrentPage("/downloads") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="download" color={isCurrentPage("/downloads") ? "var(--accent)" : undefined} />
      Downloads
      {#if trackEngine.downloadCount}<span class="caption text-subtle"
          >{trackEngine.downloadCount}</span
        >{/if}
    </a>
    <a
      class="menu-item"
      href="?/settings"
      aria-current={isCurrentPage("/settings") ? "page" : undefined}
      onclick={() => navigationDrawer?.close()}
    >
      <Icon name="settings" color={isCurrentPage("/settings") ? "var(--accent)" : undefined} />
      Settings
    </a>
  </nav>
  <section class="stack-sm" aria-label="Connection">
    <p class="caption text-secondary">
      {session.blockedAccount
        ? "Account not active"
        : session.busy
          ? "Connecting…"
          : offlineMode
            ? "Working offline"
            : "Connected"}
    </p>
    {#if session.busy}
      <button
        class="menu-item"
        disabled={!!session.blockedAccount}
        onclick={() => (session.auth ? void session.setOfflineMode(true) : session.cancelConnect())}
        >Cancel</button
      >
    {:else if session.auth}
      <button
        class="menu-item"
        disabled={!session.canResumeOnline}
        onclick={() => void session.setOfflineMode(!offlineMode)}
        >{offlineMode ? "Connect" : "Work offline"}</button
      >
    {:else}
      <a class="menu-item" href="?/settings" onclick={() => navigationDrawer?.close()}>Connect</a>
    {/if}
    {#if offlineMode}<p class="caption text-secondary">
        Server access is off. Requested downloads are paused.
      </p>{/if}
  </section>
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

<div class="app-root">
  <div class="app-shell">
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
      <aside class="sidebar app-sidebar stack-lg view-shell" aria-label="Navigation">
        {@render brand()}
        {@render navigation()}
      </aside>
      <header class="topbar app-header row-md row-justify row-wrap view-shell">
        {@render brand()}
        <div class="row-sm">
          {@render actions()}
          <a class="button" href="?/search" aria-label="Search">
            <Icon name="search" />
          </a>
          <button
            class="button"
            data-size={appUpdate?.hasUpdate ? "text" : undefined}
            data-variant={appUpdate?.hasUpdate ? "secondary" : undefined}
            aria-label="Open menu"
            aria-describedby={appUpdate?.hasUpdate ? "navigation-update-hint" : undefined}
            aria-controls="navigation-dialog"
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
        {#if session.blockedAccount}
          <div class="container-md stack-lg">
            <section class="card stack-md" aria-labelledby="account-blocked-heading">
              <h1 id="account-blocked-heading" class="heading-lg uppercase">
                {session.ownershipIssue === "unsupported"
                  ? "This browser cannot safely open this account’s local data."
                  : "This account is open in another tab"}
              </h1>
              <p class="body" style="overflow-wrap: anywhere">
                {session.blockedAccount.username} · {session.blockedAccount.host}
              </p>
              <p class="body">
                {session.ownershipIssue === "unsupported"
                  ? "Web Locks browser support is required to protect your local data."
                  : "Close the other Libras tab, then retry."}
              </p>
              <p class="body" role="status">
                {session.error.startsWith("This account is still") ? session.error : ""}
              </p>
              {#if session.ownershipIssue !== "unsupported"}
                <button
                  class="button"
                  data-size="text"
                  data-variant="primary"
                  disabled={session.busy}
                  onclick={async (event) => {
                    const button = event.currentTarget;
                    await session.retryOwnership();
                    await tick();
                    if (button.isConnected && document.activeElement === document.body)
                      button.focus();
                  }}
                >
                  {session.busy ? "Checking…" : "Retry"}
                </button>
              {/if}
              <a
                class="button"
                data-size="text"
                data-variant="secondary"
                href="?/settings"
                onclick={(event) => {
                  if (session.busy) event.preventDefault();
                  else session.chooseAnotherAccount();
                }}>Use another account</a
              >
            </section>
          </div>
        {:else if initialized}
          <Router
            routes={[
              { pattern: "/library", render: libraryRoute },
              { pattern: "/search", render: searchRoute },
              { pattern: "/library/album/:albumId", render: albumRoute },
              { pattern: "/library/artist/:artistId", render: artistRoute },
              { pattern: "/settings", render: settingsRoute },
              { pattern: "/downloads", render: downloadsRoute },
            ]}
          />
        {/if}
      </main>
      <Player
        {cache}
        {covers}
        {playback}
        {trackEngine}
        {offlineMode}
        audio={player}
        serverQueueExchange={!demo}
      />
      {#if hasErrors}
        <div id="error-popover" class="notification-popover" popover="auto" aria-label="Errors">
          <div class="stack-sm">
            {#each alerts as alert (alert.id)}
              {#if alert.message}
                <div class="stack-sm" role="alert">
                  <p class="caption">{alert.message}</p>
                  {#if alert.id === "playback" && playback.track}
                    <p class="caption text-secondary">{playback.track.title}</p>
                    <button
                      class="button"
                      data-size="text"
                      data-variant="secondary"
                      onclick={(event) => {
                        event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                        void playback.play();
                      }}>Retry playback</button
                    >
                  {/if}
                </div>
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
        class="top-sheet"
        id="navigation-dialog"
        data-swipeup="close"
        aria-label="Navigation"
        bind:this={navigationDrawer}
      >
        <div class="sheet-header row-sm row-end">
          <button
            class="button"
            data-variant="ghost"
            aria-label="Close menu"
            autofocus
            commandfor="navigation-dialog"
            command="close"
          >
            <Icon name="cross" />
          </button>
        </div>
        <div class="sheet-body">
          <div class="container-md stack-lg">
            <div class="row-sm row-center">{@render brand()}</div>
            {@render navigation()}
          </div>
        </div>
        <span class="dialog-handle" data-side="bottom" aria-hidden="true"></span>
      </dialog>
    </div>
  </div>

  {#if Updater}
    <Updater bind:this={updater} />
  {/if}
</div>
