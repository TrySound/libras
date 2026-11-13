<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Session } from "./session.svelte";
  import Loader from "./ui/loader.svelte";
  import Icon from "./icon.svelte";

  let {
    session,
    children,
    demo = false,
    appName = "Libras",
  }: { session: Session; children?: Snippet; demo?: boolean; appName?: string } = $props();
  const connectionState = $derived.by(() => {
    if (session.auth && session.offlineMode) return "offline";
    if (session.busy) return session.localReady ? "connecting" : "initializing";
    if (!session.auth) return session.status === "error" ? "error" : "disconnected";
    if (session.status === "error") return "error";
    if (session.refreshing && !session.libraryProgress) return "connected";
    return session.syncing ? "synchronizing" : "connected";
  });
  const labels = {
    initializing: "Synchronizing…",
    connecting: "Connecting…",
    synchronizing: "Synchronizing with server…",
    disconnected: "Disconnected",
    offline: "Offline mode",
    error: "Connection failed",
    connected: "Connected",
  };
  const connectionLoading = $derived(
    ["initializing", "connecting", "synchronizing"].includes(connectionState),
  );
  let deleteLocalData = $state(false);
  let cleaning = $state(false);
  async function disconnect() {
    if (cleaning || !session.disconnect()) return;
    if (!deleteLocalData) return;
    cleaning = true;
    try {
      await session.clearLocalData();
    } catch {
      /* Session reports deletion errors. */
    } finally {
      cleaning = false;
    }
  }
</script>

<svelte:head><title>Settings | {appName}</title></svelte:head>
<section aria-labelledby="settings-heading" class="stack-lg scroll-runway">
  <h1 class="heading-lg uppercase" id="settings-heading">Settings</h1>
  <div class="split-layout" data-ratio="3:2">
    <section class="card stack-md" id="settings-server" aria-labelledby="settings-server-title">
      <h2 class="heading-md uppercase" id="settings-server-title">Music server</h2>
      <div class="stack-sm" role="status" id="settings-connection-status">
        <p class="row-sm label">
          <span class="row-sm"
            >{#if connectionLoading}<Loader />{:else}<Icon
                name={connectionState === "error"
                  ? "cross"
                  : connectionState === "connected"
                    ? "check"
                    : connectionState === "offline"
                      ? "offline"
                      : "unlink"}
              />{/if}</span
          >
          {#if connectionLoading && session.libraryProgress}<span
              class="text-subtle"
              id="settings-library-progress"
              >{session.libraryProgress.albums.toLocaleString()} albums · {session.libraryProgress.tracks.toLocaleString()}
              tracks</span
            >
          {:else}<span
              ><span
                class:visually-hidden={connectionState === "connected" ||
                  connectionState === "offline"}
                >{labels[connectionState]}{#if session.auth && !connectionLoading}{" · "}{/if}</span
              >{#if session.auth && !connectionLoading}<span id="settings-server-identity"
                  >{session.auth.username}@{new URL(session.auth.host).host}</span
                >{/if}</span
            >{/if}
        </p>
        {#if session.error}<p class="body" id="settings-server-error">{session.error}</p>{/if}
      </div>
      {#if session.refreshError}<div class="card stack-sm">
          <h3 class="heading-sm">Synchronization needs attention</h3>
          <p class="body">{session.refreshError}</p>
          <p class="body">Your existing library is still available.</p>
        </div>{/if}
      {#if cleaning}<p class="row-sm body" role="status"><Loader /> Deleting local data…</p>
      {:else if session.auth}
        <p class="caption text-secondary">
          {demo
            ? "This demo uses a fixed music library. Disconnect stops streaming; reload to reconnect. Choose whether to keep its local data."
            : "Disconnect to switch users or servers. Choose whether to keep this account’s local data."}
        </p>
        <div class="row-sm row-wrap">
          <button
            id="settings-refresh"
            class="button"
            data-size="text"
            data-variant="secondary"
            aria-label={session.refreshing ? "Refreshing…" : "Refresh library"}
            aria-busy={session.refreshing}
            aria-disabled={session.syncing}
            disabled={session.offlineMode || session.busy || session.syncing}
            onclick={() => void session.refresh()}
            >{session.refreshing ? "Refreshing…" : "Refresh library"}</button
          >
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
      {:else}
        {#if demo}<p class="body">
            This demo uses a fixed music library and cannot connect to other servers. Reload to
            reconnect to the demo.
          </p>
          <button class="button" data-size="text" onclick={() => window.location.reload()}
            >Reload demo</button
          >{:else}<a
            id="settings-connect"
            class="button"
            data-size="text"
            data-variant="primary"
            href="?/connect">Connect your music server</a
          >{/if}
      {/if}
    </section>
    <section
      id="settings-offline-card"
      class="card stack-md"
      aria-labelledby="settings-offline-title"
    >
      <h2 class="heading-md uppercase" id="settings-offline-title">Connection</h2>
      {#if session.auth}
        <button
          class="button"
          data-size="text"
          data-variant="secondary"
          disabled={session.busy}
          onclick={() => void session.setOfflineMode(!session.offlineMode)}
          >{session.offlineMode ? "Connect" : "Work offline"}</button
        >
      {:else}<a class="button" data-size="text" href="?/connect">Connect</a>{/if}
      <p class="body" id="settings-offline-help">
        {session.offlineMode
          ? "Server access is off. Requested downloads are paused."
          : "Server access is on. Choose Downloaded in Library scope to browse saved music without disconnecting."}
      </p>
      <a class="button" data-size="text" data-variant="secondary" href="?/downloads"
        >View downloads</a
      >
    </section>
  </div>
  {@render children?.()}
</section>
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
  <form method="dialog" class="stack-md" onsubmit={disconnect}>
    <h2 class="heading-md" id={`${id}-title`}>Disconnect from server</h2>
    <p class="body" id={`${id}-scope`}>
      Would you also like to clear this account’s data and downloads from this device? Server data
      won’t be affected.
    </p>
    <div class="row-md">
      <input
        class="switch"
        role="switch"
        id={`${id}-delete-local`}
        type="checkbox"
        bind:checked={deleteLocalData}
        aria-describedby={`${id}-scope`}
      /><label class="body" for={`${id}-delete-local`}>Clear data on device</label>
    </div>
    <div class="row-sm row-wrap row-end">
      <button
        class="button"
        data-size="text"
        type="button"
        command="close"
        commandfor={id}
        autofocus>Cancel</button
      >
      <button class="button" data-size="text" data-variant="primary" type="submit"
        >Disconnect</button
      >
    </div>
  </form>
{/snippet}
