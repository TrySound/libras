<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import Icon, { type IconName } from "./icon.svelte";

  let {
    children,
    actions,
    hasActions,
    miniPlayer,
    embedded = false,
  }: {
    children: Snippet;
    actions: Snippet;
    hasActions: boolean;
    miniPlayer: Snippet;
    embedded?: boolean;
  } = $props();
  const links: { path: string; label: string; icon: IconName }[] = [
    { path: "/library", label: "Your library", icon: "disc" },
    { path: "/search", label: "Search", icon: "search" },
    { path: "/downloads", label: "Downloads", icon: "download" },
    { path: "/settings", label: "Settings", icon: "settings" },
  ];
  let drawer: HTMLDialogElement;
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
    return () => {
      window.removeEventListener("hashchange", sync);
      window.navigation.removeEventListener("currententrychange", sync);
    };
  });
</script>

{#snippet brand()}
  <a
    class="button-quiet row-sm"
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
        onclick={() => drawer?.close()}
      >
        <Icon name={link.icon} size={24} color={active(link.path) ? "var(--accent)" : undefined} />
        {link.label}
      </a>
    {/each}
  </nav>
{/snippet}

<div class="app-shell" data-embedded={embedded || undefined}>
  <aside class="sidebar app-sidebar stack-lg ui-edgerunner" aria-label="Navigation">
    {@render brand()}
    {@render navigation()}
  </aside>
  <header class="topbar app-header row-md row-justify row-wrap ui-edgerunner">
    {@render brand()}
    <div class="row-sm">
      {#if hasActions}
        <div class="row-sm app-status-actions">{@render actions()}</div>
      {/if}
      <a class="button app-header-action" href="#/search" aria-label="Search"
        ><Icon name="search" size={24} /></a
      >
      <button
        class="button app-header-action"
        aria-label="Open menu"
        aria-controls="navigation-dialog"
        aria-expanded={open}
        commandfor="navigation-dialog"
        command="show-modal"><Icon name="menu-lines" size={24} /></button
      >
    </div>
  </header>
  <main class="app-page">{@render children()}</main>
  {@render miniPlayer()}
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
