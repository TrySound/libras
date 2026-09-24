<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../src/icon.svelte";
  import Demo from "./demo.svelte";

  let mobile = $state(false);
  let demoDialog: HTMLDialogElement;

  onMount(() => {
    const viewport = window.matchMedia("(width < 800px)");
    const syncViewport = () => {
      if (mobile === viewport.matches) return;
      // Close transient overlays, but keep the same player and playback session.
      for (const dialog of demoDialog.querySelectorAll("dialog[open]")) {
        (dialog as HTMLDialogElement).close();
      }
      demoDialog.close();
      mobile = viewport.matches;
    };
    syncViewport();
    viewport.addEventListener("change", syncViewport);
    return () => viewport.removeEventListener("change", syncViewport);
  });

  const appUrl = new URL("../", new URL(import.meta.env.BASE_URL, location.origin)).pathname;
  const repository = "https://github.com/TrySound/libras";
  const creditsUrl = `${import.meta.env.BASE_URL}catalog/credits.html`;
  const waveform = [
    18, 32, 24, 48, 36, 64, 42, 76, 56, 88, 64, 44, 72, 96, 58, 80, 48, 68, 38, 56, 30, 44, 22, 34,
    18,
  ];
</script>

{#snippet arrow()}
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M3 8h10M8 3l5 5-5 5"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
{/snippet}

<div class="website">
  <a class="site-skip-link" href="#main-content">Skip to content</a>
  <section
    class="site-hero site-container stack-lg"
    id="main-content"
    tabindex="-1"
    aria-labelledby="hero-title"
  >
    <a class="row-sm display-lg" href={import.meta.env.BASE_URL} aria-label="Libras home">
      <Icon name="brand" size="lg" />
      <span>Libras</span>
    </a>
    <h1 class="display-xl container-md" id="hero-title">
      <span>Your own music library.</span>
      <span>Listen anywhere.</span>
    </h1>
    <p class="site-hero-description text-muted">
      A music player for Navidrome and OpenSubsonic-compatible servers. Stream your library or
      download music for offline listening.
    </p>
    <div class="site-actions">
      <a class="button" href={appUrl}>Connect your server</a>
      <button class="button mobile-only" commandfor="live-demo-dialog" command="show-modal">
        Try live demo
      </button>
      <a class="button desktop-only" href="#live-demo">Try live demo</a>
    </div>
  </section>

  <section class="site-showcase site-container" id="live-demo" aria-labelledby="demo-title">
    <div class="site-showcase-copy stack-lg">
      <h2 class="display-lg" id="demo-title">Try live demo</h2>
      <p class="type-body text-muted">
        A minimal interface. Choose an artist or album and start listening.
      </p>
      <button
        class="button site-demo-launch"
        commandfor="live-demo-dialog"
        command="show-modal"
        aria-haspopup="dialog"
      >
        Open full-screen demo
      </button>
    </div>
    <dialog
      id="live-demo-dialog"
      class="site-demo-window site-demo-dialog"
      bind:this={demoDialog}
      open={!mobile}
      aria-label="Libras live demo"
    >
      <div class="site-demo-toolbar">
        <!-- position title in the center -->
        <div class="icon-button visually-hidden" data-size="sm"></div>
        <span class="type-body text-muted">Libras</span>
        <div class="icon-button visually-hidden desktop-only" data-size="sm"></div>
        <button
          class="icon-button mobile-only"
          data-size="sm"
          data-variant="ghost"
          aria-label="Close demo"
          commandfor="live-demo-dialog"
          command="close"><Icon name="cross" /></button
        >
      </div>
      <div class="site-demo-frame" aria-label="Interactive Libras demo">
        <Demo />
      </div>
    </dialog>
  </section>

  <section
    class="site-section site-container stack-xl"
    id="features"
    aria-labelledby="features-title"
  >
    <h2 class="display-lg" id="features-title">Everything you need.</h2>
    <div class="site-feature-grid">
      <article class="site-feature site-feature-library">
        <div class="site-feature-copy stack-md">
          <div class="row-sm">
            <span class="site-feature-icon"><Icon name="music" /></span>
            <h3 class="display-md">Your collection.</h3>
          </div>
          <p class="type-body text-muted">
            Browse artists, explore albums, and search for the track stuck in your head.
          </p>
        </div>
        <div class="site-record-scene" aria-hidden="true">
          <div class="site-record-sleeve">
            <Icon name="brand" size="xl" />
          </div>
          <div class="site-vinyl"><div><Icon name="brand" /></div></div>
        </div>
      </article>
      <article class="site-feature site-feature-offline stack-md">
        <div class="row-sm">
          <span class="site-feature-icon"><Icon name="download" /></span>
          <h3 class="display-md">Take the long way home.</h3>
        </div>
        <p class="type-body text-muted">
          Download your favorites, switch to Offline Library, and keep listening when the connection
          doesn’t come along.
        </p>
        <div class="site-download-visual" aria-hidden="true">
          <div>
            <span class="site-download-art"><Icon name="music" /></span><span
              >Available offline</span
            ><span class="site-download-check"><Icon name="check" /></span>
          </div>
          <div class="site-download-line"></div>
        </div>
      </article>
      <article class="site-feature stack-md">
        <div class="row-sm">
          <span class="site-feature-icon"><Icon name="clock" /></span>
          <h3 class="display-md">Right where you left off.</h3>
        </div>
        <p class="type-body text-muted">
          Your queue and playback position are saved between sessions.
        </p>
        <div class="site-waveform" aria-hidden="true">
          {#each waveform as height, index}
            <span class:site-waveform-played={index < 14} style:height={`${height}%`}></span>
          {/each}
        </div>
      </article>
      <article class="site-feature stack-md">
        <div class="row-sm">
          <span class="site-feature-icon"><Icon name="home" /></span>
          <h3 class="display-md">Browser or app.</h3>
        </div>
        <p class="type-body text-muted">
          Listen right in your browser, or install Libras as a standalone web app. No app store
          required.
        </p>
        <div class="site-install-visual" aria-hidden="true">
          <span class="site-app-icon"><Icon name="brand" size="lg" /></span>
          <span>Libras<small>Make room for your music.</small></span>
        </div>
      </article>
      <article class="site-feature site-feature-open stack-md">
        <div class="row-sm">
          <span class="site-feature-icon site-code-icon" aria-hidden="true"> &lt;/&gt; </span>
          <h3 class="display-md">Open, in every sense.</h3>
        </div>
        <p class="type-body text-muted">
          Your server holds the music. You hold the keys. Libras is free, MIT-licensed, and open for
          you to explore or make your own.
        </p>
        <a class="text-link row-sm" href={repository} target="_blank">
          Look under the hood {@render arrow()}
        </a>
      </article>
    </div>
  </section>

  <section class="site-section site-faq site-container" aria-labelledby="faq-title">
    <h2 class="display-lg" id="faq-title">Before you press play.</h2>
    <div class="site-faq-list">
      <details name="faq">
        <summary>Is Libras a music streaming service?</summary>
        <p class="type-body text-muted">
          Libras is a player, not a music hosting service. Bring your own music library on a
          compatible server. The live demo lets you try it with a small, openly licensed collection
          before connecting your own.
        </p>
      </details>
      <details name="faq">
        <summary>Is it really free?</summary>
        <p class="type-body text-muted">
          Yes. Libras is free and open source under the MIT license, with no Libras subscription.
          You’re responsible for your own music server and any hosting costs.
        </p>
      </details>
      <details name="faq">
        <summary>How does offline listening work?</summary>
        <p class="type-body text-muted">
          Download tracks while online, then turn on Offline Library. Downloads are stored on your
          device. Clearing site data deletes your saved music.
        </p>
      </details>
      <details name="faq">
        <summary>Can I use it on my phone?</summary>
        <p class="type-body text-muted">
          Yes, use it in your browser or add it to your home screen. On iPhone and iPad, use
          Safari’s Share → Add to Home Screen. Installation varies by browser; offline storage and
          background playback have not yet been verified on iOS.
        </p>
      </details>
      <details name="faq">
        <summary>Which servers are supported?</summary>
        <p class="type-body text-muted">
          Use a reachable HTTPS server with a Subsonic-compatible API, such as Navidrome. It needs
          OpenSubsonic empty-query search3 support and CORS configured to allow requests from the
          Libras origin. <a class="text-link" href={`${repository}#get-started`} target="_blank"
            >Read the setup requirements.</a
          >
        </p>
      </details>
    </div>
  </section>

  <section class="site-final-cta site-container stack-xl" aria-labelledby="cta-title">
    <div class="site-cta-emblem" aria-hidden="true">
      <Icon name="brand" size="xl" />
    </div>
    <h2 class="display-lg container-md" id="cta-title">
      Your favorite songs are already in your library.
    </h2>
    <a class="button" href={appUrl}>Start listening</a>
  </section>

  <footer class="site-footer site-container">
    <div>
      <a class="row-sm display-md" href={import.meta.env.BASE_URL}
        ><Icon name="brand" /><span>Libras</span></a
      >
    </div>
    <nav class="row-lg text-muted type-body" aria-label="Footer navigation">
      <a class="text-link" href={repository} target="_blank">GitHub</a><a
        class="text-link"
        href={`${repository}/blob/main/LICENSE`}
        target="_blank">MIT License</a
      ><a class="text-link" href={creditsUrl}>Music credits</a>
    </nav>
  </footer>
</div>
