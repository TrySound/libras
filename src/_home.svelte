<script lang="ts">
  import type { Cache } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import type { Session } from "./session.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Playback } from "./playback.svelte";
  import type { Favourites } from "./favourites.svelte";
  import type { FavouriteKind, FavouriteDescription, FavouriteTarget } from "./schema";
  import Artwork from "./ui/artwork.svelte";
  import FavouriteButton from "./ui/favourite-button.svelte";
  import Loader from "./ui/loader.svelte";
  import Icon from "./icon.svelte";
  let {
    cache,
    covers,
    session,
    trackEngine,
    playback,
    favourites,
    kind,
    appName = "Libras",
  }: {
    cache: Cache;
    covers: Covers;
    session: Session;
    trackEngine: TrackEngine;
    playback: Playback;
    favourites: Favourites;
    kind?: FavouriteKind;
    appName?: string;
  } = $props();
  const kinds: FavouriteKind[] = ["artists", "albums", "tracks"];
  let capacity = $state(2);
  let menu = $state<FavouriteTarget>();
  const menuItem = $derived(
    menu ? cache.favourites[menu.kind].find((item) => item.id === menu?.id) : undefined,
  );
  function observeGrid(node: HTMLElement) {
    const update = () => {
      capacity = Math.max(
        2,
        getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length * 2,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => observer.disconnect();
  }
  function record(type: FavouriteKind, id: string) {
    return type === "artists"
      ? cache.artists.get(id)
      : type === "albums"
        ? cache.albums.get(id)
        : cache.tracks.get(id);
  }
  function trackIds(type: FavouriteKind, id: string) {
    const tracks =
      type === "tracks"
        ? cache.tracks.has(id)
          ? [cache.tracks.get(id)!]
          : []
        : type === "albums"
          ? (cache.albumTracks.get(id) ?? [])
          : (cache.artistAlbums.get(id) ?? []).flatMap(
              (album) => cache.albumTracks.get(album.id) ?? [],
            );
    return tracks
      .filter((track) => !session.offlineMode || trackEngine.getStatus(track.id) === "downloaded")
      .map((track) => track.id);
  }
  function items(type: FavouriteKind) {
    return [...cache.favourites[type]]
      .filter((item) => !session.offlineMode || trackIds(type, item.id).length > 0)
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }
  const sections = $derived(
    (kind ? [kind] : kinds).map((type) => {
      const eligible = items(type);
      const limit = kind ? eligible.length : type === "tracks" ? 2 : capacity;
      const overflow = eligible.length > limit;
      return {
        type,
        overflow,
        page: eligible.slice(0, overflow ? limit - 1 : limit),
        count: eligible.length,
      };
    }),
  );
  const total = $derived(kinds.reduce((sum, type) => sum + cache.favourites[type].length, 0));
  const error = $derived(
    favourites.error instanceof Error
      ? favourites.error.message
      : favourites.error
        ? "Could not refresh favourites."
        : "",
  );
  function href(type: FavouriteKind, item: FavouriteDescription) {
    return type === "artists"
      ? `?/library/artist/${encodeURIComponent(item.id)}`
      : type === "albums"
        ? `?/library/album/${encodeURIComponent(item.id)}`
        : undefined;
  }
</script>

<svelte:head><title>{kind ? `Favourite ${kind}` : "Welcome Home"} | {appName}</title></svelte:head>
<div class="home stack-xl">
  <header class="stack-md">
    <h1 class="heading-lg">{kind ? `Favourite ${kind}` : "Welcome Home"}</h1>
    {#if session.offlineMode}<p class="body text-secondary">
        Downloaded music only. Your other favourites are retained.
      </p>{/if}
    <div>
      <button
        class="button"
        data-size="text"
        data-variant="secondary"
        disabled={!favourites.available || favourites.loading}
        onclick={() => favourites.refresh().catch(() => {})}>Refresh favourites</button
      >
    </div>
    {#if !favourites.available}<p class="caption text-secondary">
        Reconnect to refresh or edit favourites. Cached music remains available.
      </p>{/if}
    {#if favourites.loading}<div class="row-sm" role="status">
        <Loader /><span>Loading favourites…</span>
      </div>{/if}
    {#if error}<div class="card stack-sm" role="alert">
        <p>{error} Cached favourites remain available.</p>
        <button
          class="button"
          data-size="text"
          disabled={!favourites.available || favourites.loading}
          onclick={() => favourites.refresh().catch(() => {})}>Retry</button
        >
      </div>{/if}
    {#if cache.favouritesError}<p class="body" role="alert">
        {cache.favouritesDirty
          ? "Saved on server; could not save this device’s cache. Cached documents are preserved."
          : "Could not restore this device’s favourites cache. Cached documents are preserved."}
      </p>{/if}
  </header>
  {#if !total && cache.favourites.fetchedAt !== null && !kind}
    <section class="stack-md">
      <h2 class="heading-md">Make yourself at home</h2>
      <p class="body">Favourite artists, albums, and tracks to find them here.</p>
      <a class="button-quiet" href="?/library">Browse artists</a>
    </section>
  {:else if !total && cache.favourites.fetchedAt === null && !favourites.loading}
    <p class="body">Favourites unavailable. Connect and refresh favourites to load them.</p>
  {:else if total || cache.favourites.fetchedAt !== null}
    {#each sections as section (section.type)}
      <section class="stack-md" aria-label={`Favourite ${section.type}`}>
        {#if !kind}<h2 class="heading-md">Favourite {section.type}</h2>{/if}
        {#if !section.count}
          <p class="body text-secondary">
            {session.offlineMode
              ? "No downloaded favourites to show. Membership is retained."
              : `No favourite ${section.type} yet. Add favourites from their actions.`}
            <a href="?/library">Browse artists</a>
          </p>
        {:else}
          <div
            class={section.type === "tracks" ? "stack-xs" : "tile-grid home-grid"}
            data-favourites={section.type}
            {@attach section.type !== "tracks" ? observeGrid : () => {}}
          >
            {#each section.page as item (item.id)}
              {@const available = !!record(section.type, item.id)}
              {#if section.type === "artists"}
                <article class="tile tile-grid-item home-artist">
                  <Artwork {covers} id={item.artworkId} size="fill" class="tile-artwork" />
                  <div class="tile-content stack-sm">
                    <h3 class="heading-sm">{item.title}</h3>
                    {#if !available}<p class="caption">Unavailable in your library</p>{/if}
                  </div>
                  {#if available}<a
                      class="link-target"
                      href={href(section.type, item)}
                      aria-label={item.title}
                      data-longpressfor="home-actions"
                      data-longpress="show-modal"
                      onfocus={() => (menu = { kind: section.type, id: item.id })}
                    ></a>{/if}
                  <div class="tile-actions">{@render actionButton(section.type, item)}</div>
                </article>
              {:else if section.type === "albums"}
                <article class="home-album stack-sm">
                  {#if available}<a
                      class="home-cover"
                      href={href(section.type, item)}
                      aria-label={item.title}
                      data-longpressfor="home-actions"
                      data-longpress="show-modal"
                      onfocus={() => (menu = { kind: section.type, id: item.id })}
                      ><Artwork {covers} id={item.artworkId} size="fill" /></a
                    >{:else}<div class="home-cover">
                      <Artwork {covers} id={item.artworkId} size="fill" />
                    </div>{/if}
                  <div class="row-sm home-metadata">
                    <div class="stack-xs">
                      <h3 class="label">{item.title}</h3>
                      <p class="caption text-secondary">{item.artist ?? ""}</p>
                      {#if !available}<p class="caption">Unavailable in your library</p>{/if}
                    </div>
                    <div>{@render actionButton(section.type, item)}</div>
                  </div>
                </article>
              {:else}
                <article class="track-row home-track">
                  <Artwork {covers} id={item.artworkId} size="sm" />
                  <div class="home-track-label">
                    <h3 class="label">{item.title}</h3>
                    <p class="caption text-secondary">
                      {item.artist ?? ""}{!available ? " · Unavailable in your library" : ""}
                    </p>
                  </div>
                  <button
                    class="button"
                    aria-label={`Play ${item.title}`}
                    data-longpressfor="home-actions"
                    data-longpress="show-modal"
                    onfocus={() => (menu = { kind: "tracks", id: item.id })}
                    disabled={!available}
                    onclick={() => playback.replaceQueueAndPlay(trackIds("tracks", item.id))}
                    ><Icon name="play" /></button
                  >
                  <div>{@render actionButton("tracks", item)}</div>
                </article>
              {/if}
            {/each}
            {#if section.overflow}<a
                class:home-overflow-square={section.type !== "tracks"}
                class="home-overflow"
                href={`?/favourites/${section.type}`}>All favourite {section.type}</a
              >{/if}
          </div>
        {/if}
      </section>
    {/each}
  {/if}
</div>
{#snippet actionButton(type: FavouriteKind, item: FavouriteDescription)}
  <button
    class="button only-mobile"
    data-variant="secondary"
    commandfor="home-actions"
    command="show-modal"
    aria-label={`Actions for ${item.title}`}
    onclick={() => (menu = { kind: type, id: item.id })}><Icon name="menu" /></button
  >
  <button
    class="button only-desktop"
    data-variant="secondary"
    commandfor="home-popover"
    command="toggle-popover"
    aria-label={`Actions for ${item.title}`}
    onclick={() => (menu = { kind: type, id: item.id })}><Icon name="menu" /></button
  >
{/snippet}
<dialog
  id="home-actions"
  class="bottom-sheet"
  aria-labelledby="home-actions-title"
  closedby="any"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render actions("home-actions", false)}
</dialog>
<div
  id="home-popover"
  class="popover"
  popover="auto"
  role="dialog"
  aria-labelledby="home-popover-title"
>
  {@render actions("home-popover", true)}
</div>
{#snippet actions(id: string, popover: boolean)}
  <div class="stack-md">
    <div class="row-md row-justify">
      <h2 class="heading-md" id={`${id}-title`}>{menuItem?.title ?? "Favourite actions"}</h2>
      <button
        class="button"
        commandfor={id}
        command={popover ? "hide-popover" : "close"}
        aria-label="Close actions"><Icon name="cross" /></button
      >
    </div>
    {#if menu}
      <FavouriteButton target={menu} />
      <button
        class="button"
        data-size="text"
        disabled={!trackIds(menu.kind, menu.id).length}
        onclick={() => {
          if (menu) void playback.replaceQueueAndPlay(trackIds(menu.kind, menu.id));
        }}>Play</button
      >
      <button
        class="button"
        data-size="text"
        disabled={!trackIds(menu.kind, menu.id).length}
        onclick={() => {
          if (menu) void playback.enqueue(trackIds(menu.kind, menu.id), "next");
        }}>Play next</button
      >
      <button
        class="button"
        data-size="text"
        disabled={!trackIds(menu.kind, menu.id).length}
        onclick={() => {
          if (menu) void playback.enqueue(trackIds(menu.kind, menu.id), "last");
        }}>Add to queue</button
      >
      <button
        class="button"
        data-size="text"
        disabled={!trackIds(menu.kind, menu.id).length}
        onclick={() => {
          if (menu) trackEngine.downloadMany(trackIds(menu.kind, menu.id));
        }}>Download</button
      >
    {/if}
  </div>
{/snippet}
