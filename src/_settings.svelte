<script lang="ts">
  import { onDestroy, tick } from "svelte";
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
  let hostInput = $state.raw<HTMLInputElement>();
  let submitButton = $state.raw<HTMLButtonElement>();
  let view = $state.raw<HTMLElement>();
  let mounted = true;

  const connectionLabels = {
    restoring: "",
    connecting: "Connecting…",
    synchronizing: "Synchronizing with server…",
    disconnected: "Disconnected",
    offline: "Offline mode",
    error: "Connection failed",
    refreshing: "Connected",
    connected: "Connected",
  };
  const connectionState = $derived.by((): keyof typeof connectionLabels => {
    if (session.busy) return session.localReady ? "connecting" : "restoring";
    if (!session.auth) return session.status === "error" ? "error" : "disconnected";
    if (session.offlineMode) return "offline";
    if (session.status === "error") return "error";
    if (session.syncing && !session.refreshing) return "synchronizing";
    // During an explicit refresh, only the library scan belongs in this row.
    return session.syncing && session.libraryProgress ? "refreshing" : "connected";
  });
  const connectionLabel = $derived(connectionLabels[connectionState]);
  const connectionLoading = $derived(
    connectionState === "connecting" ||
      connectionState === "synchronizing" ||
      connectionState === "refreshing",
  );
  const connectionFailed = $derived(connectionState === "error");
  const serverAddress = $derived.by(() => {
    if (!session.auth) return "";
    const address = new URL(session.auth.host);
    // Account identity is useful here; URL userinfo and authentication secrets are not.
    address.username = address.password = "";
    return address
      .toString()
      .replace(/^https?:\/\//i, "")
      .replace(/\/$/, "");
  });

  onDestroy(() => {
    mounted = false;
    password = "";
  });

  async function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    if (session.busy || session.auth) return;
    const sourceURL = window.location.href;
    const form = event.currentTarget;
    // Keep keyboard focus on a mounted control before disabling the fields.
    if (form instanceof HTMLFormElement && form.contains(document.activeElement))
      submitButton?.focus();
    if (await session.connect({ host, username, password })) {
      host = username = password = "";
      // Session may finish after navigation starts or an embedded app is hidden.
      if (mounted && window.location.href === sourceURL && view?.checkVisibility())
        navigate("/library");
    }
  }

  async function disconnectServer(event: MouseEvent) {
    const restoreFocus = document.activeElement === event.currentTarget;
    session.disconnect();
    host = username = password = "";
    await tick();
    if (mounted && restoreFocus && document.activeElement === document.body) hostInput?.focus();
  }
</script>

<section bind:this={view} class="ui-edgerunner settings-view" aria-labelledby="settings-heading">
  <div class="stack-lg scroll-runway">
    <h1 class="heading-xl" id="settings-heading">Settings</h1>

    <div class="split-layout" data-ratio="3:2">
      <section class="card stack-md" id="settings-server" aria-labelledby="settings-server-title">
        <h2 class="heading-md uppercase" id="settings-server-title">Music server</h2>
        <div
          class="stack-sm settings-status"
          role="status"
          aria-atomic="true"
          id="settings-connection-status"
        >
          {#if connectionState !== "restoring"}
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
                    size={24}
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
                  {connectionLabel}
                  {#if session.auth && connectionState !== "synchronizing"}
                    {connectionState === "offline" || connectionFailed ? " · " : " to "}
                    <span id="settings-server-identity"
                      >{session.auth.username}@{serverAddress}</span
                    >
                  {/if}
                </span>
              {/if}
            </p>
          {/if}
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
              <p class="caption text-secondary" id="server-host-help">
                The address of your Navidrome server.
              </p>
              <input
                class="input"
                id="server-host"
                name="host"
                type="text"
                inputmode="url"
                bind:this={hostInput}
                bind:value={host}
                placeholder="music.example.com"
                autocomplete="url"
                autocapitalize="off"
                spellcheck="false"
                aria-describedby="server-host-help"
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
                bind:this={submitButton}
                id="settings-connect"
                class="button"
                type="submit"
                data-size="text"
                data-variant="secondary"
                aria-disabled={session.busy}
                aria-busy={session.busy}
              >
                {#if session.busy}<Loader />{/if}
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

<style>
  /* Temporary page placement until the shell migration owns shared gutters. */
  .settings-view {
    box-sizing: border-box;
    min-block-size: 100%;
    padding: var(--content-padding-block) var(--content-padding-inline);
    overflow-wrap: anywhere;
  }

  .settings-status {
    min-block-size: 1.5rem;
  }
</style>
