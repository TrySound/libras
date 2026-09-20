<script lang="ts">
  import type { Session } from "../src/session.svelte";
  let { session, creditsUrl }: { session: Session; creditsUrl: string } = $props();
</script>

<section class="view container settings-view stack-md">
  <div class="stack-sm">
    <span class="type-eyebrow text-muted">Demo settings</span>
    <h2 class="type-heading">Demo music library</h2>
    <p class="type-body text-muted">
      Music is served by this website. Your queue, preferences and downloads stay in this browser,
      separate from your regular Libras library. No server login is needed.
    </p>
  </div>
  <section class="card row-md" aria-label="Demo library">
    <div class="stack-xs grow">
      <strong class="type-title"
        >{session.syncing
          ? "Refreshing…"
          : session.offlineMode
            ? "Offline library"
            : "Connected to the demo"}</strong
      >
      <small class="type-small text-muted">
        <a class="text-link" href={creditsUrl} target="_blank" rel="noopener"
          >Music credits and licenses</a
        >
      </small>
    </div>
    <button
      class="button"
      data-size="sm"
      data-variant="neutral"
      disabled={session.offlineMode || session.busy || session.syncing}
      onclick={() => void session.refresh()}>Refresh library</button
    >
  </section>
  <section class="card row-md" aria-label="Offline library">
    <div class="stack-xs grow">
      <strong class="type-title">Offline library</strong>
      <small class="type-small text-muted">
        Show only music downloaded to this device. <a class="text-link" href="#/downloads"
          >View downloads</a
        >
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
  </section>
  <p class="type-small text-muted">
    This demo is not an installable PWA. Opening or reloading it requires an internet connection,
    even when you have downloaded music.
  </p>
</section>
