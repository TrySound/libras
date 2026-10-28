<script lang="ts">
  import Icon from "./icon.svelte";
  import Loader from "./ui/loader.svelte";
  import type { Session } from "./session.svelte";
  import { navigate } from "./router.svelte";

  interface Props {
    session: Session;
  }

  let { session }: Props = $props();
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
    if (await session.connect({ host, username, password })) {
      host = username = password = "";
      // Session may finish after navigation starts or an embedded app is hidden.
      if (window.location.href === sourceURL && view?.checkVisibility()) navigate("/library");
    }
  }

  function disconnectServer() {
    session.disconnect();
    host = username = password = "";
  }
</script>

<section bind:this={view} class="settings-view" aria-labelledby="settings-heading">
  <div class="stack-lg scroll-runway">
    <h1 class="heading-xl" id="settings-heading">Settings</h1>

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
                {#if connectionState !== "connected"}{connectionLabel}{/if}
                {#if session.auth && !connectionLoading}
                  {#if connectionState === "offline" || connectionFailed}
                    ·
                  {/if}
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

        {#if !session.auth}
          <form
            class="stack-md"
            onsubmit={submitConnection}
            aria-busy={session.busy}
            aria-describedby={session.error
              ? "settings-auth-help settings-server-error"
              : "settings-auth-help"}
          >
            <p class="caption text-secondary" id="settings-auth-help">
              Sign in to your Navidrome server to listen to your music.
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
                data-variant="secondary"
                aria-disabled={session.busy}
                aria-busy={session.busy}
              >
                {#if session.busy}
                  <Loader />
                {/if}
                {session.busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        {:else}
          <div class="stack-md">
            <p class="caption text-secondary">
              Disconnect to change servers. Your offline library will stay on this device.
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
                class="button"
                data-size="text"
                onclick={disconnectServer}>Disconnect</button
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
        <div class="row-md row-justify">
          <h2 class="heading-md uppercase" id="settings-offline-title">Offline library</h2>
          <input
            class="switch"
            id="settings-offline"
            type="checkbox"
            role="switch"
            aria-labelledby="settings-offline-title"
            aria-describedby="settings-offline-help"
            checked={session.offlineMode}
            disabled={!session.auth || session.busy}
            onchange={(event) => void session.setOfflineMode(event.currentTarget.checked)}
          />
        </div>
        <p class="body" id="settings-offline-help">
          {#if !session.auth}
            Connect to a server to browse online. Your saved music remains available.
          {:else}
            Show downloaded music only. Turn this off to browse and stream from your server.
          {/if}
        </p>
        <div class="row-sm">
          <a class="button" data-size="text" data-variant="secondary" href="#/downloads"
            >View downloads</a
          >
        </div>
      </section>
    </div>
  </div>
</section>
