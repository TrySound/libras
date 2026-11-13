<script lang="ts">
  import type { Session } from "./session.svelte";
  import { navigate } from "./router.svelte";
  import Loader from "./ui/loader.svelte";

  let {
    session,
    demo = false,
    appName = "Libras",
  }: { session: Session; demo?: boolean; appName?: string } = $props();
  let host = $state("");
  let username = $state("");
  let password = $state("");
  let remember = $state(false);
  let view: HTMLElement;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (session.busy) return;
    const sourceURL = window.location.href;
    const result = session.connect({ host, username, password }, remember);
    password = "";
    if (await result) {
      host = username = password = "";
      if (window.location.href === sourceURL && view?.checkVisibility()) navigate("/library");
    }
  }
</script>

<svelte:head><title>Connect | {appName}</title></svelte:head>
<section id="connect-screen" bind:this={view} class="container-md stack-lg scroll-runway">
  <h1 class="heading-lg uppercase">Connect your music server</h1>
  <p class="body">Use an HTTPS OpenSubsonic-compatible server that allows this app through CORS.</p>
  {#if demo}
    <p class="body">The demo uses a fixed library. Reload to reconnect.</p>
    <button class="button" data-size="text" onclick={() => window.location.reload()}
      >Reload demo</button
    >
  {:else if session.auth}
    <p class="body">
      {session.offlineMode ? "Working offline" : "Connected"} · {session.auth.username}@{new URL(
        session.auth.host,
      ).host}
    </p>
    <button
      class="button"
      data-size="text"
      disabled={session.busy}
      onclick={() => void session.setOfflineMode(!session.offlineMode)}
      >{session.offlineMode ? "Connect" : "Work offline"}</button
    >
    <a class="button" data-size="text" href="?/settings">Account settings</a>
  {:else}
    <form
      id="connection-form"
      method="post"
      class="card stack-md"
      onsubmit={submit}
      aria-busy={session.busy}
      aria-describedby={session.error ? "connection-help connection-error" : "connection-help"}
    >
      <div class="stack-xs">
        <label class="label" for="server-host">Host</label>
        <input
          class="input"
          id="server-host"
          name="host"
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
          bind:value={username}
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
          autocomplete="current-password"
          required
          disabled={session.busy}
        />
      </div>
      <div class="row-sm">
        <input
          id="remember-device"
          name="remember"
          type="checkbox"
          bind:checked={remember}
          disabled={session.busy}
          aria-describedby="remember-help"
        />
        <label class="body" for="remember-device">Remember this device</label>
      </div>
      <p class="caption text-secondary" id="remember-help">
        Keep sign-in credentials in this browser after closing it. Use only on a trusted device.
      </p>
      <p id="connection-help" class="caption text-secondary">
        Without remembering, you’ll need to sign in again after reloading. Downloaded music stays on
        this device.
      </p>
      {#if session.libraryProgress}<p id="connection-library-progress" class="body" role="status">
          {session.libraryProgress.albums.toLocaleString()} albums · {session.libraryProgress.tracks.toLocaleString()}
          tracks
        </p>{/if}
      {#if session.error}<p id="connection-error" class="body" role="status">
          {session.error}
        </p>{/if}
      <div class="row-sm row-wrap">
        <button
          id="connection-submit"
          class="button"
          type="submit"
          aria-busy={session.busy}
          data-size="text"
          data-variant="primary"
          disabled={session.busy}
          >{#if session.busy}<Loader />{/if}{session.busy ? "Connecting…" : "Connect"}</button
        >
        {#if session.busy}<button
            class="button"
            type="button"
            data-size="text"
            onclick={() => {
              session.cancelConnect();
              password = "";
            }}>Cancel</button
          >{/if}
      </div>
    </form>
  {/if}
  <a class="button" data-size="text" data-variant="secondary" href="?/library">Open library</a>
</section>
