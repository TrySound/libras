<script lang="ts">
  import type { Session } from "./session.svelte";
  import { navigate } from "./router.svelte";

  interface Props {
    session: Session;
  }

  let { session }: Props = $props();
  const loading = $derived(!session.localReady);
  let host = $state("");
  let username = $state("");
  let password = $state("");
  const statusLabel = $derived(
    session.busy
      ? "Connecting…"
      : !session.auth
        ? "Disconnected"
        : session.offlineMode
          ? "Offline mode"
          : session.status === "error"
            ? "Connection failed"
            : session.syncing
              ? "Refreshing…"
              : "Connected",
  );

  async function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    if (await session.connect({ host, username, password })) {
      host = username = password = "";
      navigate("/library");
    }
  }

  function disconnectServer() {
    session.disconnect();
    host = username = password = "";
  }
</script>

<section class="view settings-view stack-md">
  <div class="stack-sm">
    <span class="type-eyebrow text-muted">Settings</span>
    <h2 class="type-heading">
      {session.auth ? "Music server" : "Connect to your music"}
    </h2>
    <p class="type-body text-muted">
      {session.auth
        ? "Disconnect first to change servers. Your offline library will stay on this device."
        : "Enter your music server details. Authentication stays on this device."}
    </p>
  </div>

  <section class="connection-card" aria-label="Music server">
    <div class="connection-card-header">
      <span
        class="connection-dot"
        class:offline={session.offlineMode}
        class:connected={!session.offlineMode && session.status === "connected" && !session.syncing}
        class:connecting={session.busy || session.syncing}
        class:failed={session.status === "error"}
      ></span>
      <span class="connection-summary stack-xs">
        <strong class="type-title">
          {session.auth?.host ?? "Add a server"}
        </strong>
        {#if session.auth || session.busy}
          <small class="type-small text-muted">
            {session.auth ? `${session.auth.username} · ${statusLabel}` : statusLabel}
          </small>
        {/if}
        {#if (session.busy || session.syncing) && session.libraryProgress}
          <small class="type-small text-muted" role="status">
            {session.libraryProgress.albums.toLocaleString()} albums · {session.libraryProgress.tracks.toLocaleString()}
            tracks
          </small>
        {/if}
      </span>
      {#if session.auth}
        <div class="connection-actions">
          <button
            class="icon-button"
            data-size="md"
            data-variant="neutral"
            aria-label={session.syncing ? "Refreshing…" : "Refresh library"}
            title={session.syncing ? "Refreshing…" : "Refresh library"}
            disabled={session.offlineMode || session.busy || session.syncing}
            onclick={() => void session.refresh()}
          >
            <svg aria-hidden="true" width="20" height="20">
              <use href={session.syncing ? "#icon-loading" : "#icon-refresh"}></use>
            </svg>
          </button>
          <button
            class="icon-button"
            data-size="md"
            data-variant="neutral"
            aria-label="Disconnect"
            title="Disconnect"
            onclick={disconnectServer}
          >
            <svg aria-hidden="true" width="20" height="20">
              <use href="#icon-disconnect"></use>
            </svg>
          </button>
        </div>
      {/if}
    </div>
    {#if !session.auth}
      <div class="connection-details">
        {#if !session.auth}
          <form class="stack-md" onsubmit={submitConnection}>
            <div class="stack-sm">
              <div class="stack-xs">
                <label for="server-host">Host</label>
                <input
                  id="server-host"
                  type="text"
                  bind:value={host}
                  placeholder="https://music.example.com"
                  autocomplete="url"
                  required
                  disabled={session.busy}
                />
              </div>
              <div class="stack-xs">
                <label for="server-username">Username</label>
                <input
                  id="server-username"
                  type="text"
                  bind:value={username}
                  autocomplete="username"
                  required
                  disabled={session.busy}
                />
              </div>
              <div class="stack-xs">
                <label for="server-password">Password</label>
                <input
                  id="server-password"
                  type="password"
                  bind:value={password}
                  autocomplete="current-password"
                  required
                  disabled={session.busy}
                />
              </div>
            </div>
            <button
              class="button"
              type="submit"
              data-size="md"
              data-variant="neutral"
              disabled={session.busy}
            >
              {session.busy ? "Connecting…" : "Connect"}
            </button>
            <small>Authentication is saved in this browser after a successful login.</small>
          </form>
        {/if}
      </div>
    {/if}
  </section>

  <div class="settings-option">
    <div class="stack-xs">
      <strong class="type-title">Offline library</strong>
      <small class="type-small text-muted">
        {#if !session.auth}
          Connect to a server to browse online.
        {:else if loading}
          Restoring local library…
        {:else}
          Show only music downloaded to this device.
        {/if}
        <a class="text-link" href="#/downloads">View downloads</a>
      </small>
    </div>
    <label class="switch">
      <input
        type="checkbox"
        aria-label="Offline library"
        checked={session.offlineMode}
        disabled={!session.auth || session.busy}
        onchange={(event) => void session.setOfflineMode(event.currentTarget.checked)}
      />
    </label>
  </div>
</section>
