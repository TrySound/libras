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
    class="shell-brand button-quiet row-sm"
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

<div class="app-shell navigation-shell" class:embedded bind:this={root}>
  {#if embedded}
    <div class="shell-canvas ui-edgerunner" aria-hidden="true"></div>
  {/if}
  <aside
    class="sidebar app-sidebar stack-lg ui-edgerunner"
    aria-label="Navigation"
    bind:this={sidebar}
  >
    {@render brand()}
    {@render navigation()}
  </aside>
  <header class="topbar app-header row-md row-justify row-wrap ui-edgerunner" bind:this={header}>
    {@render brand()}
    <div class="row-sm header-actions">
      <div class="row-sm app-status-actions">{@render actions()}</div>
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
  <main class="app-page" id="main-content">{@render children()}</main>
  <dialog
    class="right-sheet ui-edgerunner"
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
  /* Shell composition only. Shared components own surfaces, spacing and motion. */
  .app-shell {
    --sidebar-width: 280px;
    position: relative;
    min-block-size: 100%;
    container: navigation / inline-size;
  }
  .app-shell:not(.embedded) {
    min-block-size: 100dvh;
  }
  /* Standalone has one document-owned canvas, not a gradient restarted by
   * each route's intrinsic content height. Embedded routes keep their canvas. */
  .app-shell:not(.embedded) .app-page > :global(.ui-edgerunner) {
    background: transparent;
  }
  .app-shell.embedded {
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
  .app-sidebar {
    position: fixed;
    inset: 0 auto var(--player-clearance, 0px) 0;
    inline-size: var(--sidebar-width);
    /* Reserve the persistent error/update controls above the legacy player. */
    padding-block-end: 4rem;
  }
  .embedded .app-sidebar {
    position: absolute;
  }
  .app-page {
    min-inline-size: 0;
    padding-block-end: calc(
      var(--player-clearance, 0px) + var(--space-lg) + env(safe-area-inset-bottom)
    );
  }
  .app-status-actions:empty {
    display: none;
  }
  .embedded :global(.right-sheet) {
    position: fixed;
    position-anchor: --libras-app;
    inset: anchor(top) anchor(right) auto auto;
    inline-size: min(360px, calc(anchor-size(width) - 2 * var(--space-md)));
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
  @container navigation (width >= 64rem) {
    /* Keep one mounted set of status controls without a desktop topbar. */
    .app-header,
    .header-actions {
      display: contents;
    }
    .app-header > :global(.shell-brand):not(:focus-within),
    .mobile-action:not(:focus) {
      display: none;
    }
    .app-status-actions {
      position: fixed;
      inset: auto auto var(--player-clearance, 0px) 0;
      inline-size: var(--sidebar-width);
      box-sizing: border-box;
      padding: var(--space-sm) var(--content-padding-inline);
      z-index: var(--layer-header);
    }
    .embedded .app-status-actions {
      position: absolute;
    }
    .app-page {
      padding-inline-start: var(--sidebar-width);
    }
  }
  @container navigation (width < 64rem) {
    .app-sidebar:not(:focus-within) {
      display: none;
    }
  }
</style>
