<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../src/icon.svelte";
  import Demo from "./demo.svelte";

  let mobile = $state(false);
  let demoDialog: HTMLDialogElement;

  onMount(() => {
    const viewport = window.matchMedia("(width < 700px)");
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
  <header class="site-header">
    <nav class="site-container site-nav" aria-label="Main navigation">
      <a class="site-brand" href={import.meta.env.BASE_URL} aria-label="Libras home">
        <Icon name="brand" size="lg" />
        <span>libras<span class="site-brand-period">.</span></span>
      </a>
      <div class="site-nav-links">
        <a href="#features">Features</a>
        <a href="#how-it-works">How it works</a>
        <a href={repository}>GitHub <span aria-hidden="true">↗</span></a>
      </div>
      <a class="site-button site-button-small site-button-outline" href={appUrl}>
        Open app {@render arrow()}
      </a>
    </nav>
  </header>

  <section
    class="site-hero site-container"
    id="main-content"
    tabindex="-1"
    aria-labelledby="hero-title"
  >
    <div class="site-grid-decoration" aria-hidden="true"></div>
    <a class="site-announcement" href={repository}>
      <span class="site-live-dot"></span>
      Independent by design. Open source by default.
      {@render arrow()}
    </a>
    <h1 id="hero-title">All your music.<br /><span>None of the noise.</span></h1>
    <p class="site-hero-description">
      A quieter home for the music you love. Connect your own server, find an old favorite, and get
      lost in an album. Libras takes care of the rest.
    </p>
    <div class="site-actions">
      <a class="site-button site-button-primary" href={appUrl}>Start listening {@render arrow()}</a>
      {#if mobile}
        <button
          class="site-button site-button-secondary"
          commandfor="live-demo-dialog"
          command="show-modal"
          aria-haspopup="dialog"><Icon name="play" /> Try the live demo</button
        >
      {:else}
        <a class="site-button site-button-secondary" href="#live-demo"
          ><Icon name="play" /> Try the live demo</a
        >
      {/if}
    </div>
    <p class="site-hero-footnote">Your server. Your collection. No Libras subscription.</p>
    <div class="site-compatibility" aria-label="Compatibility">
      <span>MADE FOR YOUR STACK</span>
      <a href="https://www.navidrome.org/">Navidrome</a>
      <span class="site-compatibility-plus" aria-hidden="true">+</span>
      <a href="https://opensubsonic.net/">Subsonic-compatible servers</a>
    </div>
  </section>

  <section class="site-showcase site-container" id="live-demo" aria-labelledby="demo-title">
    <div class="site-showcase-copy">
      <span class="site-eyebrow"><span>01 /</span> THE EXPERIENCE</span>
      <h2 id="demo-title">Less interface.<br />More music.</h2>
      <p class="site-description">
        No feed to scroll. No algorithm to please. Just your artists, your albums, and the next
        track.
      </p>
      <div class="site-demo-invitation">
        <span class="site-demo-play"><Icon name="play" /></span>
        <div>
          <strong>This is the real thing.</strong>
          <p>Pick an artist. Open an album. Press play.</p>
        </div>
      </div>
      <button
        class="site-button site-button-primary site-demo-launch"
        commandfor="live-demo-dialog"
        command="show-modal"
        aria-haspopup="dialog"
      >
        <Icon name="play" /> Open full-screen demo
      </button>
      <p class="site-fine-print">
        A live, preconnected library. No account needed.<br /><a href={creditsUrl}
          >Demo music & credits <span aria-hidden="true">↗</span></a
        >
      </p>
    </div>
    <dialog
      id="live-demo-dialog"
      class="site-demo-window site-demo-dialog"
      bind:this={demoDialog}
      open={!mobile}
      aria-label="Libras live demo"
    >
      <div class="site-demo-toolbar">
        <div class="site-window-dots" aria-hidden="true"><i></i><i></i><i></i></div>
        <span>your library, anywhere</span>
        <span class="site-demo-status"><span class="site-live-dot"></span> LIVE</span>
        <button
          class="site-demo-close icon-button"
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
      <div class="site-demo-caption">
        <Icon name="music" /> A small window into your next favorite listen.
      </div>
    </dialog>
  </section>

  <section class="site-section site-container" id="features" aria-labelledby="features-title">
    <div class="site-section-heading">
      <span class="site-eyebrow"><span>02 /</span> INTENTIONALLY SIMPLE</span>
      <h2 id="features-title">
        Everything you need.<br /><span>Nothing between you and play.</span>
      </h2>
      <p class="site-description">
        A thoughtfully small player for a collection that’s entirely yours.
      </p>
    </div>
    <div class="site-feature-grid">
      <article class="site-feature site-feature-library">
        <div class="site-feature-copy">
          <span class="site-feature-icon"><Icon name="music" /></span>
          <h3>Your collection. Front and center.</h3>
          <p>
            Browse artists, explore albums, and search for the track stuck in your head. Your music
            is the main event.
          </p>
        </div>
        <div class="site-record-scene" aria-hidden="true">
          <div class="site-record-sleeve">
            <Icon name="brand" size="xl" /><span>THE ART OF<br />JUST LISTENING.</span><small
              >LIBRAS / VOL. 001</small
            >
          </div>
          <div class="site-vinyl"><div><Icon name="brand" /></div></div>
        </div>
      </article>
      <article class="site-feature site-feature-offline">
        <span class="site-feature-icon"><Icon name="download" /></span>
        <h3>Take the long way home.</h3>
        <p>
          Download your favorites, switch to Offline Library, and keep listening when the connection
          doesn’t come along.
        </p>
        <div class="site-download-visual" aria-hidden="true">
          <div>
            <span class="site-download-art"><Icon name="music" /></span><span
              >Saved for the journey<small>Available offline</small></span
            ><span class="site-download-check"><Icon name="check" /></span>
          </div>
          <div class="site-download-line"></div>
          <span class="site-mono">YOUR MUSIC. NO SIGNAL REQUIRED.</span>
        </div>
      </article>
      <article class="site-feature">
        <span class="site-feature-icon"><Icon name="clock" /></span>
        <h3>Right where you left off.</h3>
        <p>
          Your queue and playback position are saved between sessions. Come back to the music, not
          the setup.
        </p>
        <div class="site-waveform" aria-hidden="true">
          {#each waveform as height, index}
            <span class:site-waveform-played={index < 14} style:height={`${height}%`}></span>
          {/each}
        </div>
        <div class="site-progress-labels" aria-hidden="true">
          <span>02:34</span><span>STILL YOUR MOMENT</span><span>04:12</span>
        </div>
      </article>
      <article class="site-feature">
        <span class="site-feature-icon"><Icon name="home" /></span>
        <h3>A browser tab. Or a home.</h3>
        <p>
          Listen right in your browser, or install Libras as a standalone web app. No app store
          required.
        </p>
        <div class="site-install-visual" aria-hidden="true">
          <span class="site-app-icon"><Icon name="brand" size="lg" /></span><span
            >Libras<small>Make room for your music.</small></span
          ><span class="site-install-plus">+</span>
        </div>
      </article>
      <article class="site-feature site-feature-open">
        <span class="site-feature-icon site-code-icon" aria-hidden="true">&lt;/&gt;</span>
        <h3>Open, in every sense.</h3>
        <p>
          Your server holds the music. You hold the keys. Libras is free, MIT-licensed, and open for
          you to explore or make your own.
        </p>
        <a class="site-text-link" href={repository}>Look under the hood {@render arrow()}</a>
        <span class="site-open-watermark" aria-hidden="true">{`{ }`}</span>
      </article>
    </div>
  </section>

  <section class="site-section site-container" id="how-it-works" aria-labelledby="steps-title">
    <div class="site-section-heading">
      <span class="site-eyebrow"><span>03 /</span> BRING YOUR OWN MUSIC</span>
      <h2 id="steps-title">From your server.<br /><span>Straight to your speakers.</span></h2>
    </div>
    <div class="site-steps">
      <article>
        <span class="site-step-number">01</span>
        <h3>Bring your library</h3>
        <p>
          Run Navidrome or a compatible Subsonic server. Your music stays hosted where you choose.
        </p>
        <a class="site-text-link" href="https://www.navidrome.org/docs/"
          >New to self-hosting? {@render arrow()}</a
        >
      </article>
      <article>
        <span class="site-step-number">02</span>
        <h3>Make the connection</h3>
        <p>
          Open Libras and enter your HTTPS server address and credentials. Your library is ready to
          explore.
        </p>
      </article>
      <article>
        <span class="site-step-number">03</span>
        <h3>Find your rhythm</h3>
        <p>
          Queue an album, save tracks for offline, or install the app. Build a listening habit
          that’s yours.
        </p>
      </article>
    </div>
    <p class="site-server-note">
      <Icon name="settings" /> Your server needs browser access (CORS) and OpenSubsonic empty-query search
      support.
      <a href={`${repository}#get-started`}
        >Connection requirements <span aria-hidden="true">↗</span></a
      >
    </p>
  </section>

  <section class="site-section site-faq site-container" aria-labelledby="faq-title">
    <div>
      <span class="site-eyebrow"><span>04 /</span> A FEW GOOD QUESTIONS</span>
      <h2 id="faq-title">Before you<br /><span>press play.</span></h2>
      <p class="site-description">Small app. No big mysteries.</p>
    </div>
    <div class="site-faq-list">
      <details>
        <summary>Is Libras a music streaming service?<span aria-hidden="true">+</span></summary>
        <p>
          Libras is a player, not a music hosting service. Bring your own music library on a
          compatible server. The live demo lets you try it with a small, openly licensed collection
          before connecting your own.
        </p>
      </details>
      <details>
        <summary>Is it really free?<span aria-hidden="true">+</span></summary>
        <p>
          Yes. Libras is free and open source under the MIT license, with no Libras subscription.
          You’re responsible for your own music server and any hosting costs.
        </p>
      </details>
      <details>
        <summary>How does offline listening work?<span aria-hidden="true">+</span></summary>
        <p>
          Download tracks while online, then turn on Offline Library. Downloads are stored in this
          browser on this device, separately for each server and account. Clearing site data deletes
          your saved music.
        </p>
      </details>
      <details>
        <summary>Can I use it on my phone?<span aria-hidden="true">+</span></summary>
        <p>
          Yes, use it in your browser or add it to your home screen. On iPhone and iPad, use
          Safari’s Share → Add to Home Screen. Installation varies by browser; offline storage and
          background playback have not yet been verified on iOS.
        </p>
      </details>
      <details>
        <summary>Which servers are supported?<span aria-hidden="true">+</span></summary>
        <p>
          Use a reachable HTTPS server with a Subsonic-compatible API, such as Navidrome. It needs
          OpenSubsonic empty-query search3 support and CORS configured to allow requests from the
          Libras origin. <a href={`${repository}#get-started`}>Read the setup requirements.</a>
        </p>
      </details>
    </div>
  </section>

  <section class="site-final-cta site-container" aria-labelledby="cta-title">
    <div class="site-cta-emblem" aria-hidden="true"><Icon name="brand" size="xl" /></div>
    <span class="site-eyebrow">LESS NOISE. MORE YOU.</span>
    <h2 id="cta-title">Your next good listen<br />is already in your library.</h2>
    <a class="site-button site-button-primary" href={appUrl}
      >Make yourself at home {@render arrow()}</a
    >
    <p>Free. Open source. Yours to play.</p>
  </section>

  <footer class="site-footer site-container">
    <div>
      <a class="site-brand" href={import.meta.env.BASE_URL}
        ><Icon name="brand" /><span>libras.</span></a
      >
      <p>A little less software. A little more music.</p>
    </div>
    <nav aria-label="Footer navigation">
      <a href={repository}>GitHub ↗</a><a href={`${repository}/blob/main/LICENSE`}>MIT License</a><a
        href={creditsUrl}>Music credits</a
      >
    </nav>
    <span class="site-footer-note">Made for the love of listening.</span>
  </footer>
</div>
