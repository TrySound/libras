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
    if (session.status === "connecting") return session.localReady ? "connecting" : "initializing";
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

  async function finishDisconnect(cleanup: boolean) {
    if (session.cleaning) return;
    host = username = password = "";
    if (cleanup) {
      try {
        await session.cleanup();
        window.location.reload();
      } catch {
        // Session retains recovery state even if Settings was unmounted meanwhile.
        return;
      }
    } else session.disconnect();
  }
</script>

<svelte:head><title>Settings | {appName}</title></svelte:head>

<dialog id="disconnect-dialog" class="dialog" closedby="any" aria-labelledby="disconnect-title">
  <div class="stack-md">
    <h2 class="heading-md" id="disconnect-title">Disconnect?</h2>
    <div class="stack-xs">
      <div class="row-md row-justify row-wrap">
        <label class="body" for="disconnect-delete-local" style="flex: 1 1 14ch"
          >Delete account data and downloads from device</label
        >
        <input
          class="switch"
          id="disconnect-delete-local"
          type="checkbox"
          role="switch"
          bind:checked={deleteLocalData}
          aria-describedby="disconnect-scope"
        />
      </div>
      <p class="caption text-secondary" id="disconnect-scope">Server data is unaffected.</p>
    </div>
    <div class="row-sm row-wrap row-end">
      <button
        class="button"
        data-size="text"
        data-variant="secondary"
        command="close"
        commandfor="disconnect-dialog">Cancel</button
      >
      <button
        class="button"
        data-size="text"
        data-variant="primary"
        command="close"
        commandfor="disconnect-dialog"
        onclick={() => void finishDisconnect(deleteLocalData)}>Disconnect</button
      >
    </div>
  </div>
</dialog>

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
                {connectionLabel}
                {#if session.auth && !connectionLoading}
                  ·
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

        {#if session.cleaning}
          <p class="row-sm body" role="status"><Loader /> Deleting local data…</p>
        {:else if session.cleanupError}
          <p class="body" role="alert">{session.cleanupError}</p>
          <button
            class="button"
            data-size="text"
            data-variant="primary"
            onclick={() => void finishDisconnect(true)}>Retry cleanup</button
          >
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
                class="button"
                data-size="text"
                command="show-modal"
                commandfor="disconnect-dialog"
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
        <div class="row-md row-justify">
          <h2 class="heading-md uppercase" id="settings-offline-title">
            <label for="settings-offline">Offline library</label> is {session.offlineMode
              ? "on"
              : "off"}
          </h2>
          <input
            class="switch"
            id="settings-offline"
            type="checkbox"
            role="switch"
            aria-describedby="settings-offline-help"
            checked={session.offlineMode}
            disabled={!session.auth || session.busy}
            onchange={(event) => void session.setOfflineMode(event.currentTarget.checked)}
          />
        </div>
        <p class="body" id="settings-offline-help">
          {#if !session.auth}
            {demo
              ? "Reload the demo to browse online. Any previews you kept remain available."
              : "Connect to a server to browse online. Any music you kept remains available."}
          {:else if session.offlineMode}
            Showing downloaded music only. Turn this off to browse and stream {demo
              ? "demo previews"
              : "from your server"}.
          {:else}
            Browse your full library and stream {demo ? "demo previews" : "from your server"}. Turn
            this on to show downloaded music only.
          {/if}
          Requested downloads continue when connected, including with Offline library on.
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
