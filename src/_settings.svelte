<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./icon.svelte";
  import Loader from "./ui/loader.svelte";
  import type { Session } from "./session.svelte";
  import { navigate } from "./router.svelte";

  interface Props {
    session: Session;
    children?: Snippet;
    demo?: boolean;
    appName?: string;
  }

  let { session, children, demo = false, appName = "Libras" }: Props = $props();
  let host = $state("");
  let username = $state("");
  let password = $state("");
  let view = $state.raw<HTMLElement>();

  const connectionLabels = {
    initializing: "Synchronizing…",
    connecting: "Connecting…",
    synchronizing: "Synchronizing with server…",
    disconnected: "Disconnected",
    offline: "Offline mode",
    error: "Connection failed",
    connected: "Connected",
  };
  const connectionState = $derived.by((): keyof typeof connectionLabels => {
    if (session.auth && session.offlineMode) return "offline";
    if (session.busy) return session.localReady ? "connecting" : "initializing";
    if (!session.auth) return session.status === "error" ? "error" : "disconnected";
    if (session.status === "error") return "error";
    // A manual refresh keeps the existing status until scan counts are available.
    if (session.refreshing && !session.libraryProgress) return "connected";
    return session.syncing ? "synchronizing" : "connected";
  });
  const connectionLabel = $derived(connectionLabels[connectionState]);
  const connectionLoading = $derived(
    connectionState === "initializing" ||
      connectionState === "connecting" ||
      connectionState === "synchronizing",
  );
  const connectionFailed = $derived(connectionState === "error");
  const serverAddress = $derived(session.auth ? new URL(session.auth.host).host : "");

  async function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    const sourceURL = window.location.href;
    const result = session.connect({ host, username, password });
    password = "";
    if (await result) {
      host = username = password = "";
      // Session may finish after navigation starts or Settings is hidden.
      if (window.location.href === sourceURL && view?.checkVisibility()) navigate("/library");
    }
  }

  function cancelConnection() {
    session.cancelConnect();
    password = "";
  }

  let deleteLocalData = $state(false);

  let cleaning = $state(false);

  async function finishDisconnect() {
    if (cleaning) return;
    if (!session.disconnect()) return;
    host = username = password = "";
    if (!deleteLocalData) return;
    cleaning = true;
    try {
      await session.clearLocalData();
    } catch {
      // Disconnect succeeds even if optional local deletion fails.
    } finally {
      cleaning = false;
    }
  }
</script>

<svelte:head><title>Settings | {appName}</title></svelte:head>

<dialog
  id="disconnect-dialog"
  class="dialog"
  closedby="any"
  aria-labelledby="disconnect-dialog-title"
>
  {@render disconnectConfirmation("disconnect-dialog")}
</dialog>

<dialog
  id="disconnect-sheet"
  class="bottom-sheet"
  closedby="any"
  aria-labelledby="disconnect-sheet-title"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render disconnectConfirmation("disconnect-sheet")}
</dialog>

{#snippet disconnectConfirmation(id: string)}
  <form
    method="dialog"
    class="stack-md"
    aria-labelledby={`${id}-title`}
    onsubmit={finishDisconnect}
  >
    <h2 class="heading-md" id={`${id}-title`}>Disconnect from server</h2>
    <p class="body" id={`${id}-scope`}>
      Would you also like to clear this account’s data and downloads from this device? Server data
      won’t be affected.
    </p>
    <div class="row-md">
      <input
        class="switch"
        id={`${id}-delete-local`}
        type="checkbox"
        role="switch"
        bind:checked={deleteLocalData}
        aria-describedby={`${id}-scope`}
      />
      <label class="body" for={`${id}-delete-local`}>Clear data on device</label>
    </div>
    <div class="row-sm row-wrap row-end">
      <button
        class="button"
        data-size="text"
        data-variant="secondary"
        type="button"
        command="close"
        commandfor={id}>Cancel</button
      >
      <button class="button" data-size="text" data-variant="primary" type="submit"
        >Disconnect</button
      >
    </div>
  </form>
{/snippet}

<section bind:this={view} aria-labelledby="settings-heading">
  <div class="stack-lg scroll-runway">
    <h1 class="heading-lg uppercase" id="settings-heading">Settings</h1>

    <div class="split-layout" data-ratio="3:2">
      <section class="card stack-md" id="settings-server" aria-labelledby="settings-server-title">
        <h2 class="heading-md uppercase" id="settings-server-title">Music server</h2>
        <div class="stack-sm" role="status" aria-atomic="true" id="settings-connection-status">
          <p class="row-sm label">
            <span class="row-sm">
              {#if connectionLoading}
                <Loader />
              {:else}
                <Icon
                  name={connectionFailed
                    ? "cross"
                    : connectionState === "connected"
                      ? "check"
                      : connectionState === "offline"
                        ? "offline"
                        : "unlink"}
                  color={connectionFailed
                    ? "var(--error-text)"
                    : connectionState === "connected"
                      ? "var(--accent)"
                      : "var(--text-primary)"}
                />
              {/if}
            </span>
            {#if connectionLoading && session.libraryProgress}
              <span class="text-subtle" id="settings-library-progress">
                {session.libraryProgress.albums.toLocaleString()} albums · {session.libraryProgress.tracks.toLocaleString()}
                tracks
              </span>
            {:else}
              <span>
                <span
                  class:visually-hidden={connectionState === "connected" ||
                    connectionState === "offline"}
                >
                  {connectionLabel}
                  {#if session.auth && !connectionLoading}
                    ·
                  {/if}
                </span>
                {#if session.auth && !connectionLoading}
                  <span id="settings-server-identity">{session.auth.username}@{serverAddress}</span>
                {/if}
              </span>
            {/if}
          </p>
          {#if session.error}
            <p class="body" id="settings-server-error">{session.error}</p>
          {/if}
        </div>

        {#if session.refreshError}
          <div class="card stack-sm">
            <h3 class="heading-sm">Synchronization needs attention</h3>
            <p class="body">{session.refreshError}</p>
            <p class="body">Your existing library is still available.</p>
          </div>
        {/if}

        {#if cleaning}
          <p class="row-sm body" role="status"><Loader /> Deleting local data…</p>
        {:else if !session.auth && demo}
          <p class="body">
            This demo uses a fixed music library and cannot connect to other servers. Reload to
            reconnect to the demo.
          </p>
          <div class="row-sm">
            <button
              class="button"
              data-size="text"
              data-variant="secondary"
              onclick={() => window.location.reload()}>Reload demo</button
            >
          </div>
        {:else if !session.auth}
          <form
            method="post"
            class="stack-md"
            onsubmit={submitConnection}
            aria-busy={session.busy}
            aria-describedby={session.error
              ? "settings-auth-help settings-server-error"
              : "settings-auth-help"}
          >
            <p class="caption text-secondary" id="settings-auth-help">
              Connect to your Navidrome or another OpenSubsonic-compatible server to browse your
              library and stream music.
            </p>
            <div class="stack-xs">
              <label class="label" for="server-host">Host</label>
              <input
                class="input"
                id="server-host"
                name="host"
                type="text"
                inputmode="url"
                bind:value={host}
                placeholder="music.example.com"
                autocomplete="url"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                required
                disabled={session.busy}
              />
            </div>
            <div class="stack-xs">
              <label class="label" for="server-username">Username</label>
              <input
                class="input"
                id="server-username"
                name="username"
                type="text"
                bind:value={username}
                placeholder="Your username"
                autocomplete="username"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                required
                disabled={session.busy}
              />
            </div>
            <div class="stack-xs">
              <label class="label" for="server-password">Password</label>
              <input
                class="input"
                id="server-password"
                name="password"
                type="password"
                bind:value={password}
                placeholder="Your password"
                autocomplete="current-password"
                required
                disabled={session.busy}
              />
            </div>
            <div class="row-sm">
              <button
                id="settings-connect"
                class="button"
                type="submit"
                data-size="text"
                data-variant="primary"
                aria-disabled={session.busy}
                aria-busy={session.busy}
              >
                {#if session.busy}
                  <Loader />
                {/if}
                {session.busy ? "Connecting…" : "Connect"}
              </button>
              {#if session.busy}
                <button class="button" type="button" data-size="text" onclick={cancelConnection}>
                  Cancel
                </button>
              {/if}
            </div>
          </form>
        {:else}
          <div class="stack-md">
            <p class="caption text-secondary">
              {#if demo}
                This demo uses a fixed music library. Disconnect stops streaming; reload to
                reconnect. Choose whether to keep its local data.
              {:else}
                Disconnect to switch users or servers. Choose whether to keep this account’s local
                data.
              {/if}
            </p>
            <div class="row-sm row-wrap">
              <button
                class="button"
                data-size="text"
                data-variant="secondary"
                id="settings-refresh"
                aria-label={session.refreshing ? "Refreshing…" : "Refresh library"}
                aria-disabled={session.syncing}
                aria-busy={session.refreshing}
                disabled={session.offlineMode || session.busy}
                onclick={() => {
                  if (!session.syncing) void session.refresh();
                }}
              >
                {session.refreshing ? "Refreshing…" : "Refresh library"}
              </button>
              <button
                id="settings-disconnect"
                class="button only-desktop"
                data-size="text"
                command="show-modal"
                commandfor="disconnect-dialog"
                onclick={() => (deleteLocalData = false)}>Disconnect</button
              >
              <button
                id="settings-disconnect-mobile"
                class="button only-mobile"
                data-size="text"
                command="show-modal"
                commandfor="disconnect-sheet"
                onclick={() => (deleteLocalData = false)}>Disconnect</button
              >
            </div>
          </div>
        {/if}
      </section>

      <section
        class="card stack-md"
        id="settings-offline-card"
        aria-labelledby="settings-offline-title"
      >
        <h2 class="heading-md uppercase" id="settings-offline-title">Connection</h2>
        <p class="label">
          {session.busy ? "Connecting…" : session.offlineMode ? "Working offline" : "Connected"}
        </p>
        {#if session.auth}
          <button
            class="button"
            data-size="text"
            data-variant="secondary"
            disabled={session.busy}
            aria-describedby="settings-offline-help"
            onclick={() => void session.setOfflineMode(!session.offlineMode)}
            >{session.offlineMode ? "Connect" : "Work offline"}</button
          >
        {/if}
        <p class="body" id="settings-offline-help">
          {#if !session.auth}
            {demo
              ? "Reload the demo to browse online. Any previews you kept remain available."
              : "Connect to a server to browse online. Any music you kept remains available."}
          {:else if session.offlineMode}
            Server access is off. Requested downloads are paused.
          {:else}
            Server access is on. Choose Downloaded in Library scope to browse saved music without
            disconnecting.
          {/if}
        </p>
        <div class="row-sm">
          <a class="button" data-size="text" data-variant="secondary" href="?/downloads"
            >View downloads</a
          >
        </div>
      </section>
    </div>

    {@render children?.()}
  </div>
</section>
