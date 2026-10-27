<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import Icon, { type IconName } from "./icon.svelte";

  let {
    children,
    actions,
    embedded = false,
  }: {
    children: Snippet;
    actions: Snippet;
    embedded?: boolean;
  } = $props();
  const links: { path: string; label: string; icon: IconName }[] = [
    { path: "/library", label: "Your library", icon: "disc" },
    { path: "/search", label: "Search", icon: "search" },
    { path: "/downloads", label: "Downloads", icon: "download" },
    { path: "/settings", label: "Settings", icon: "settings" },
  ];
  let root: HTMLDivElement;
  let sidebar: HTMLElement;
  let header: HTMLElement;
  let drawer: HTMLDialogElement;
  let menu: HTMLButtonElement;
  let path = $state("/library");
  let open = $state(false);
  const active = (destination: string) =>
    path === destination || path.startsWith(`${destination}/`);

  onMount(() => {
    const sync = () => {
      const current = window.location.hash.slice(1);
      // Router falls back to Library for unknown URLs; keep navigation consistent.
      path = links.find((link) => current === link.path)?.path ?? "/library";
      if (drawer.open) drawer.close();
    };
    sync();
    window.addEventListener("hashchange", sync);
    window.navigation.addEventListener("currententrychange", sync);
    // Observe the actual app width: a narrow embedded app must not gain a sidebar.
    let desktop = false;
    const observer = new ResizeObserver(() => {
      const next =
        root.clientWidth >= 64 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (next === desktop) return;
      desktop = next;
      const focused = document.activeElement as HTMLElement | null;
      const outgoing = next
        ? header.contains(focused) || drawer.contains(focused)
        : sidebar.contains(focused);
      const key = focused?.closest<HTMLElement>("[data-nav]")?.dataset.nav;
      if (next && drawer.open) drawer.close();
      if (!outgoing) return;
      const target = next
        ? (sidebar.querySelector<HTMLElement>(`[data-nav="${key ?? path.split("/")[1]}"]`) ??
          sidebar.querySelector<HTMLElement>('[aria-current="page"]'))
        : (header.querySelector<HTMLElement>(`[data-nav="${key}"]`) ?? menu);
      target?.focus({ preventScroll: true });
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", sync);
      window.navigation.removeEventListener("currententrychange", sync);
    };
  });
</script>

{#snippet brand()}
  <a
    class="shell-brand row-sm"
    href="#/library"
    aria-label="Libras home"
    data-nav="brand"
    onclick={() => drawer?.close()}
  >
    <Icon name="brand" size={32} color="var(--accent)" />
    <span class="brand uppercase">Libras</span>
  </a>
{/snippet}

{#snippet navigation()}
  <nav class="stack-sm" aria-label="Main navigation">
    {#each links as link}
      <a
        class="menu-item"
        href={`#${link.path}`}
        title={link.label}
        aria-label={link.label}
        aria-current={active(link.path) ? "page" : undefined}
        data-nav={link.path.slice(1)}
        onclick={() => drawer?.close()}
      >
        <Icon name={link.icon} size={24} color={active(link.path) ? "var(--accent)" : undefined} />
        {link.label}
      </a>
    {/each}
  </nav>
{/snippet}

<div class="navigation-shell" class:embedded bind:this={root}>
  {#if embedded}
    <div class="shell-canvas ui-edgerunner" aria-hidden="true"></div>
  {/if}
  <aside class="shell-sidebar ui-edgerunner" aria-label="Navigation" bind:this={sidebar}>
    <div class="stack-lg">
      {@render brand()}
      {@render navigation()}
    </div>
  </aside>
  <header class="shell-header ui-edgerunner" bind:this={header}>
    {@render brand()}
    <div class="row-sm shell-header-actions">
      {@render actions()}
      <a class="button mobile-action" href="#/search" aria-label="Search" data-nav="search"
        ><Icon name="search" size={24} /></a
      >
      <button
        class="button mobile-action"
        aria-label="Open menu"
        aria-controls="navigation-dialog"
        aria-expanded={open}
        bind:this={menu}
        commandfor="navigation-dialog"
        command="show-modal"><Icon name="menu-lines" size={24} /></button
      >
    </div>
  </header>
  <main class="shell-content" id="main-content">{@render children()}</main>
  <dialog
    class="navigation-drawer ui-edgerunner"
    id="navigation-dialog"
    aria-label="Navigation"
    closedby="any"
    bind:this={drawer}
    ontoggle={() => {
      open = drawer.open;
    }}
  >
    <div class="stack-lg">
      <header class="row-md row-justify">
        {@render brand()}
        <button
          class="button"
          aria-label="Close menu"
          commandfor="navigation-dialog"
          command="close"><Icon name="cross" size={24} /></button
        >
      </header>
      {@render navigation()}
    </div>
  </dialog>
</div>

<style>
  .navigation-shell {
    --sidebar-width: 280px;
    position: relative;
    min-block-size: 100%;
    container: navigation / inline-size;
  }
  .navigation-shell:not(.embedded) {
    min-block-size: 100dvh;
  }
  /* Standalone has one document-owned canvas, not a gradient restarted by
   * each route's intrinsic content height. Embedded routes keep their canvas. */
  .navigation-shell:not(.embedded) .shell-content > :global(.ui-edgerunner) {
    background: transparent;
  }
  .navigation-shell.embedded {
    block-size: 100%;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .shell-canvas {
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--canvas-bg);
  }
  .shell-sidebar {
    display: none;
  }
  .shell-header {
    position: sticky;
    inset-block-start: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
    box-sizing: border-box;
    min-block-size: 60px;
    padding: max(var(--space-sm), env(safe-area-inset-top))
      max(var(--content-padding-inline), env(safe-area-inset-right)) var(--space-sm)
      max(var(--content-padding-inline), env(safe-area-inset-left));
    background: var(--shell-bg);
    backdrop-filter: blur(4px);
    border-block-end: var(--border-width) solid var(--shell-border);
  }
  .shell-brand {
    color: var(--text-primary);
    text-decoration: none;
  }
  .shell-brand:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .shell-content {
    min-inline-size: 0;
    padding-block-end: calc(var(--player-clearance, 0px) + 1.5rem + env(safe-area-inset-bottom));
  }
  .navigation-drawer {
    box-sizing: border-box;
    inset: 0 0 0 auto;
    margin: 0;
    inline-size: min(360px, 100%);
    max-inline-size: 100%;
    block-size: 100dvh;
    max-block-size: 100dvh;
    padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
      max(24px, env(safe-area-inset-bottom)) 24px;
    border: 0;
    border-inline-start: var(--border-width) solid var(--shell-border);
    background: var(--shell-bg);
    color: var(--text-primary);
    overflow: auto;
    overscroll-behavior: contain;
  }
  .navigation-drawer::backdrop {
    overflow: hidden;
    overscroll-behavior: contain;
    background: var(--canvas-bg);
    opacity: 0.65;
  }
  @media (prefers-reduced-motion: no-preference) {
    .navigation-drawer {
      transform: translateX(100%);
      transition:
        transform 180ms ease-out,
        display 180ms allow-discrete,
        overlay 180ms allow-discrete;
    }
    .navigation-drawer[open] {
      transform: translateX(0);
    }
    @starting-style {
      .navigation-drawer[open] {
        transform: translateX(100%);
      }
    }
  }
  .embedded .navigation-drawer {
    position: fixed;
    position-anchor: --libras-app;
    inset: anchor(top) anchor(right) auto auto;
    inline-size: min(360px, anchor-size(width));
    block-size: anchor-size(height);
  }
  /* Notifications enter the top layer too; constrain them to the embedded
   * app's anchor rather than positioning them in the host viewport. */
  .embedded :global(.notification-popover) {
    position-anchor: --libras-app;
    inset: calc(anchor(top) + 1rem) calc(anchor(right) + 1rem) auto auto;
    inline-size: min(26rem, calc(anchor-size(width) - 2rem));
    max-block-size: calc(anchor-size(height) - 2rem);
  }
  @container navigation (width > 600px) {
    .shell-header {
      min-block-size: 76px;
    }
  }
  @container navigation (width >= 64rem) {
    .shell-sidebar {
      display: block;
      position: fixed;
      inset: 0 auto var(--player-clearance, 0px) 0;
      box-sizing: border-box;
      inline-size: var(--sidebar-width);
      padding: var(--content-padding-block) var(--content-padding-inline) 4rem;
      overflow: auto;
      overscroll-behavior: contain;
      background: var(--surface-bg);
      border-inline-end: var(--border-width) solid var(--shell-border);
    }
    .embedded .shell-sidebar {
      position: absolute;
    }
    .shell-header {
      position: fixed;
      inset: auto auto var(--player-clearance, 0px) 0;
      inline-size: var(--sidebar-width);
      min-block-size: 0;
      border: 0;
      background: transparent;
      backdrop-filter: none;
    }
    .shell-header > :global(.shell-brand):not(:focus-within),
    .mobile-action:not(:focus) {
      display: none;
    }
    .embedded .shell-header {
      position: absolute;
    }
    .shell-content {
      padding-inline-start: var(--sidebar-width);
    }
  }
  @container navigation (width < 64rem) {
    .shell-sidebar:focus-within {
      display: block;
      position: absolute;
      z-index: 12;
      background: var(--surface-bg);
    }
  }
</style>
