<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./icon.svelte";
  import Loader from "./ui/loader.svelte";
  import type { Session } from "./session.svelte";
  import type { AuthenticatedConnection, LoginMethod } from "./auth.svelte";
  import { navigate } from "./router.svelte";

  interface Props {
    session: Session;
    children?: Snippet;
    demo?: boolean;
    appName?: string;
  }

  let { session, children, demo = false, appName = "Libras" }: Props = $props();
  const login = $derived(session.login);
  const error = $derived(login.error || session.error);
  let host = $state("");
  let username = $state("");
  let password = $state("");
  let apiKey = $state("");
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
    if (!session.auth) return error || session.status === "error" ? "error" : "disconnected";
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

  function clearSecrets() {
    username = password = apiKey = "";
  }

  $effect(() => {
    // Disconnect can also be issued outside this view while a secret is being edited.
    if (!login.host && session.status === "disconnected") clearSecrets();
  });

  function changeHost() {
    session.cancelConnect();
    login.cancel();
    clearSecrets();
  }

  function changeMethod(method: LoginMethod) {
    session.cancelConnect();
    login.setMethod(method);
    clearSecrets();
  }

  async function finishConnection(pending: Promise<AuthenticatedConnection | undefined>) {
    const sourceURL = window.location.href;
    if (await session.connect(await pending)) {
      host = "";
      clearSecrets();
      // Session may finish after navigation starts or Settings is hidden.
      if (window.location.href === sourceURL && view?.checkVisibility()) navigate("/library");
    }
  }

  async function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    if (session.busy || login.passwordConfirmation) return;
    if (!login.host) {
      await login.discover(host);
      return;
    }
    const pending = login.connect(
      login.method === "apiKey"
        ? { host, method: "apiKey", apiKey }
        : { host, method: login.method, username, password },
    );
    clearSecrets();
    await finishConnection(pending);
  }

  function disconnectServer() {
    session.disconnect();
    host = "";
    clearSecrets();
  }
</script>

<svelte:head><title>Settings | {appName}</title></svelte:head>

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
          {#if error}
            <p class="body" id="settings-server-error">{error}</p>
          {/if}
        </div>

        {#if session.refreshError}
          <div class="card stack-sm">
            <h3 class="heading-sm">Synchronization needs attention</h3>
            <p class="body">{session.refreshError}</p>
            <p class="body">Your existing library is still available.</p>
          </div>
        {/if}

        {#if !session.auth && demo}
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
            class="stack-md"
            method="post"
            onsubmit={submitConnection}
            aria-busy={session.busy}
            aria-describedby={error
              ? "settings-auth-help settings-server-error"
              : "settings-auth-help"}
          >
            <p class="caption text-secondary" id="settings-auth-help">
              Connect to your OpenSubsonic server to browse your library and stream music. First,
              check its authentication capabilities without sending credentials.
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
                oninput={changeHost}
                placeholder="music.example.com"
                autocomplete="url"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                required
              />
            </div>
            {#if login.host}
              <fieldset class="stack-sm">
                <legend class="label">Authentication method</legend>
                {#each [{ method: "apiKey", label: "API key" }, { method: "token", label: "Username and password (MD5 token)" }, { method: "password", label: "Direct password (legacy)" }] as choice}
                  <label class="row-sm">
                    <input
                      type="radio"
                      name="method"
                      value={choice.method}
                      checked={login.method === choice.method}
                      onchange={() => changeMethod(choice.method as LoginMethod)}
                    />
                    {choice.label}
                  </label>
                {/each}
              </fieldset>
              {#if login.passwordConfirmation}
                <div class="card stack-sm" role="alert" id="settings-password-warning">
                  <h3 class="heading-sm">Confirm direct password authentication</h3>
                  <p class="body">
                    {login.passwordConfirmation === "unsupported"
                      ? "The server explicitly rejected MD5 token authentication (code 41 or 42)."
                      : "You selected legacy password authentication."}
                    This sends your password directly to the server over HTTPS, rather than an MD5 token.
                    Hex encoding is not encryption. Continue only if you trust this server.
                  </p>
                  <p class="caption text-secondary">
                    Your password is saved in localStorage on this device until you disconnect.
                    Browser scripts can read it; use a trusted device.
                  </p>
                  <button
                    type="button"
                    class="button"
                    data-size="text"
                    data-variant="primary"
                    id="settings-confirm-password"
                    onclick={() => {
                      const pending = login.confirmPassword();
                      clearSecrets();
                      void finishConnection(pending);
                    }}
                  >
                    Confirm and send password
                  </button>
                </div>
              {:else if login.method === "apiKey"}
                <p class="caption text-secondary" id="settings-key-help">
                  Generate an API key in your server's settings. No username is needed. API keys are
                  remembered on this device until you disconnect; treat them like passwords.
                </p>
                <div class="stack-xs">
                  <label class="label" for="server-api-key">API key</label>
                  <input
                    class="input"
                    id="server-api-key"
                    name="apiKey"
                    type="password"
                    bind:value={apiKey}
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                    aria-describedby="settings-key-help"
                    required
                    disabled={session.busy}
                  />
                </div>
              {:else}
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
              {/if}
            {/if}
            <div class="row-sm">
              {#if !login.passwordConfirmation}
                <button
                  id="settings-connect"
                  class="button"
                  type="submit"
                  data-size="text"
                  data-variant="primary"
                  disabled={session.busy}
                  aria-disabled={session.busy}
                  aria-busy={session.busy}
                >
                  {#if session.busy}
                    <Loader />
                  {/if}
                  {session.busy
                    ? "Connecting…"
                    : !login.host
                      ? "Check server"
                      : login.method === "password"
                        ? "Review password warning"
                        : "Connect"}
                </button>
              {/if}
              {#if session.busy || login.passwordConfirmation}
                <button
                  type="button"
                  class="button"
                  data-size="text"
                  data-variant="secondary"
                  onclick={() => {
                    session.cancelConnect();
                    login.cancel(false);
                    clearSecrets();
                  }}>Cancel</button
                >
              {/if}
            </div>
          </form>
        {:else}
          <div class="stack-md">
            <p class="caption text-secondary">
              {#if demo}
                This demo uses a fixed music library. Disconnect stops streaming; reload to
                reconnect. Your downloaded previews stay on this device.
              {:else}
                Disconnect to change servers. Your offline library will stay on this device.
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
          <h2 class="heading-md uppercase" id="settings-offline-title">
            <span id="settings-offline-label">Offline library</span> is {session.offlineMode
              ? "on"
              : "off"}
          </h2>
          <input
            class="switch"
            id="settings-offline"
            type="checkbox"
            role="switch"
            aria-labelledby="settings-offline-label"
            aria-describedby="settings-offline-help"
            checked={session.offlineMode}
            disabled={!session.auth || session.busy}
            onchange={(event) => void session.setOfflineMode(event.currentTarget.checked)}
          />
        </div>
        <p class="body" id="settings-offline-help">
          {#if !session.auth}
            {demo
              ? "Reload the demo to browse online. Your downloaded previews remain available."
              : "Connect to a server to browse online. Your saved music remains available."}
          {:else if session.offlineMode}
            Showing downloaded music only. Turn this off to browse and stream {demo
              ? "demo previews"
              : "from your server"}.
          {:else}
            Browse your full library and stream {demo ? "demo previews" : "from your server"}. Turn
            this on to show downloaded music only.
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
