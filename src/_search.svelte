<script module lang="ts">
  import fuzzysort from "fuzzysort";
  import type { Album, Artist, Track } from "./schema";
  import type { Immutable } from "./cache.svelte";

  const searchGroups = ["Artists", "Albums", "Tracks"] as const;

  type SearchGroup = (typeof searchGroups)[number];

  interface SearchRecord {
    id: string;
    title: string;
    artist: string;
    album: string;
    href?: string;
    artworkId?: string;
  }

  export function createSearchState() {
    return {
      query: "",
      types: [] as import("./search-url").SearchType[],
      limits: { Artists: 3, Albums: 3, Tracks: 3 },
    };
  }

  type SearchState = ReturnType<typeof createSearchState>;

  function availableTrackIds(
    tracks: readonly Immutable<Track>[],
    isAvailable: (id: string) => boolean,
  ) {
    return tracks.filter((track) => isAvailable(track.id)).map((track) => track.id);
  }

  const downloadPresentation = {
    failed: { icon: "download", label: "Download" },
    idle: { icon: "download", label: "Download" },
    downloaded: { icon: "check", label: "Downloaded" },
    queued: { icon: "clock", label: "Queued" },
    downloading: { icon: "loading", label: "Downloading…" },
  } as const;

  /** Pure, ephemeral snapshots. Eligibility is applied before matching or limiting. */
  export function createSearchIndex(
    artists: ReadonlyMap<string, Immutable<Artist>>,
    albums: ReadonlyMap<string, Immutable<Album>>,
    tracks: ReadonlyMap<string, Immutable<Track>>,
    available?: (id: string) => boolean,
  ) {
    const eligibleTracks = [...tracks.values()].filter(
      (track) => !available || available(track.id),
    );
    const albumIds = new Set(eligibleTracks.map((track) => track.albumId));
    const eligibleAlbums = [...albums.values()].filter(
      (album) => !available || albumIds.has(album.id),
    );
    const artistIds = new Set(eligibleAlbums.flatMap((album) => album.artistIds));
    const artistPath = (id: string) => `?/library/artist/${encodeURIComponent(id)}`;
    const records: Record<SearchGroup, SearchRecord[]> = {
      Artists: [...artists.values()]
        .filter((artist) => !available || artistIds.has(artist.id))
        .map((artist) => ({
          id: artist.id,
          title: artist.name,
          artworkId: artist.artworkId,
          artist: "",
          album: "",
          href: artistPath(artist.id),
        })),
      Albums: eligibleAlbums.map((album) => ({
        id: album.id,
        title: album.title,
        artworkId: album.artworkId,
        artist:
          album.displayArtist ??
          album.artistIds.map((id) => artists.get(id)?.name ?? "").join(", "),
        album: "",
        href: `?/library/album/${encodeURIComponent(album.id)}`,
      })),
      Tracks: eligibleTracks.map((track) => ({
        id: track.id,
        title: track.title,
        artworkId: track.artworkId,
        artist: track.displayArtist ?? artists.get(track.artistIds[0])?.name ?? "",
        album: albums.get(track.albumId)?.title ?? "",
      })),
    };
    const snapshot = (group: SearchGroup) =>
      fuzzysort.snapshot(records[group], {
        keys: ["title", "artist", "album"],
      });
    return {
      records,
      Artists: snapshot("Artists"),
      Albums: snapshot("Albums"),
      Tracks: snapshot("Tracks"),
      size: Object.values(records).reduce((sum, group) => sum + group.length, 0),
    };
  }

  export function searchLibrary(
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    browse = false,
  ) {
    query = query.trim().replace(/\s+/g, " ");
    const groups = searchGroups.map((group) => {
      // Retrieve matches explicitly without a library limit so equal scores can be
      // ordered deterministically before applying the UI limit.
      const matches = query
        ? [
            ...fuzzysort.go(query, index[group], {
              limit: 0,
              // Keep consonant abbreviations such as “frmtn” → “Formation”.
              threshold: 0.2,
              scoreFn: (result) => result.score * (0.8 + 0.2 * result[0].score),
            }),
          ].sort(
            (a, b) => b.score - a.score || (a.obj.id < b.obj.id ? -1 : a.obj.id > b.obj.id ? 1 : 0),
          )
        : [];
      return {
        group,
        total: !query && browse ? index.records[group].length : matches.length,
        records: !query && browse ? index.records[group] : matches.map((result) => result.obj),
      };
    });
    return { query, groups };
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "./icon.svelte";
  import VirtualList from "./ui/virtual-list.svelte";
  import { navigate } from "./router.svelte";
  import { searchHref, searchTypes, type SearchType } from "./search-url";
  import type { Cache } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
  import Loader from "./ui/loader.svelte";
  import { formatDuration } from "./time";
  import type { TrackEngine } from "./track.svelte";
  import type { Session } from "./session.svelte";
  import type { Playback } from "./playback.svelte";

  let {
    cache,
    covers,
    trackEngine,
    session,
    playback,
    appName = "Libras",
    state: searchState,
    criteria,
  }: {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playback: Playback;
    state: SearchState;
    criteria?: { query: string; types: SearchType[] };
    appName?: string;
  } = $props();

  const index = $derived(
    createSearchIndex(
      cache.artists,
      cache.albums,
      cache.tracks,
      session.offlineMode ? isAvailable : undefined,
    ),
  );

  $effect(() => {
    if (!criteria) return;
    const current = searchState;
    const incoming = criteria;
    untrack(() => {
      if (
        current.query !== incoming.query ||
        JSON.stringify(current.types) !== JSON.stringify(incoming.types)
      ) {
        current.limits = createSearchState().limits;
      }
      current.query = incoming.query;
      current.types = [...incoming.types];
      dismissActions();
    });
  });

  const selectedTypes = $derived(searchState.types ?? []);
  const singleType = $derived(selectedTypes.length === 1);
  const criteriaKey = $derived(JSON.stringify([searchState.query, selectedTypes]));
  const matches = $derived(searchLibrary(index, searchState.query, singleType));

  function updateCriteria(history: "push" | "replace") {
    searchState.limits = createSearchState().limits;
    dismissActions();
    window.scrollTo({ top: 0 });
    if (criteria)
      navigate(
        searchHref(searchState.query, selectedTypes).slice(1) + window.location.hash,
        history,
        { preserveScroll: true },
      );
  }

  function toggleType(type: SearchType) {
    searchState.types = selectedTypes.includes(type)
      ? selectedTypes.filter((value) => value !== type)
      : searchTypes.filter((value) => value === type || selectedTypes.includes(value));
    updateCriteria("push");
  }
  const currentTrackId = $derived(cache.queue.tracks[cache.queue.index]);
  const libraryError = $derived(
    session.refreshError ||
      session.error ||
      (cache.reportingError ? "Some local data could not be restored or saved." : ""),
  );

  const results = $derived(
    matches.groups
      .filter((_, i) => !selectedTypes.length || selectedTypes.includes(searchTypes[i]))
      .map((result) => ({
        ...result,
        records: singleType
          ? result.records
          : result.records.slice(0, searchState.limits[result.group]),
      })),
  );

  function isAvailable(id: string) {
    return !session.offlineMode || trackEngine.getStatus(id) === "downloaded";
  }

  let menuSelection = $state.raw<{
    cache: Cache;
    group: SearchGroup;
    id: string;
  }>();

  const menuItem = $derived.by(() => {
    if (!menuSelection || menuSelection.cache !== cache) return;
    const { group, id } = menuSelection;
    const item =
      group === "Artists"
        ? cache.artists.get(id)
        : group === "Albums"
          ? cache.albums.get(id)
          : cache.tracks.get(id);
    return item
      ? { group, id, title: "name" in item ? item.name : item.title, artworkId: item.artworkId }
      : undefined;
  });

  const menuTracks = $derived.by(() => {
    if (!menuItem) return [];
    if (menuItem.group === "Artists") {
      return (cache.artistAlbums.get(menuItem.id) ?? []).flatMap(
        (album) => cache.albumTracks.get(album.id) ?? [],
      );
    }
    if (menuItem.group === "Albums") return cache.albumTracks.get(menuItem.id) ?? [];
    const track = cache.tracks.get(menuItem.id);
    return track ? [track] : [];
  });

  const menuTrackIds = $derived(availableTrackIds(menuTracks, isAvailable));
  const menuDownloadStatus = $derived(
    menuItem?.group === "Tracks" ? trackEngine.getStatus(menuItem.id) : "idle",
  );

  let menuInvoker: HTMLElement | undefined;

  function selectMenu(group: SearchGroup, id: string) {
    menuSelection = { cache, group, id };
    if (document.activeElement instanceof HTMLElement) menuInvoker = document.activeElement;
  }

  $effect(() => {
    void cache;
    untrack(() => {
      dismissActions();
      menuSelection = undefined;
      menuInvoker = undefined;
    });
  });

  function menuVisibility(open: boolean) {
    const active = document.activeElement;
    const restoreFocus =
      active === document.body ||
      active === menuInvoker ||
      (active && (sheet?.contains(active) || popover?.contains(active)));
    if (!open && menuOpen && menuInvoker?.isConnected && restoreFocus) {
      // Restore before releasing the pinned row, including a scrolled-away invoker.
      // Light dismissal onto another control must not steal that control's focus.
      menuInvoker.focus();
      menuInvoker.scrollIntoView({ block: "nearest" });
    }
    menuOpen = open;
  }

  let menuOpen = $state(false);
  let sheet: HTMLDialogElement;
  let popover: HTMLDivElement;

  function dismissActions() {
    sheet?.close();
    popover?.hidePopover?.();
    menuVisibility(false);
  }

  function supportingText(group: SearchGroup, record: SearchRecord) {
    if (group === "Artists") {
      const albums = (cache.artistAlbums.get(record.id) ?? []).filter(
        (album) =>
          !session.offlineMode ||
          (cache.albumTracks.get(album.id) ?? []).some((track) => isAvailable(track.id)),
      );
      const count = albums.reduce(
        (sum, album) =>
          sum + availableTrackIds(cache.albumTracks.get(album.id) ?? [], isAvailable).length,
        0,
      );
      return `${albums.length} album${albums.length === 1 ? "" : "s"} · ${count} track${count === 1 ? "" : "s"}`;
    }
    if (group === "Albums") {
      const album = cache.albums.get(record.id);
      const count = availableTrackIds(cache.albumTracks.get(record.id) ?? [], isAvailable).length;
      return [record.artist, album?.year, `${count} track${count === 1 ? "" : "s"}`]
        .filter((value) => value !== undefined && value !== "")
        .join(" · ");
    }
    return [record.artist, record.album].filter(Boolean).join(" · ");
  }

  function playMenu() {
    if (!menuItem) return;
    if (menuItem.group === "Tracks") play(menuItem.id);
    else void playback.replaceQueueAndPlay(menuTrackIds);
  }

  function trackContext(id: string) {
    const track = cache.tracks.get(id);
    return track ? availableTrackIds(cache.albumTracks.get(track.albumId) ?? [], isAvailable) : [];
  }

  function play(id: string) {
    const ids = trackContext(id);
    const index = ids.indexOf(id);
    if (index >= 0) void playback.replaceQueueAndPlay(ids, index);
  }
</script>

<svelte:head><title>Search | {appName}</title></svelte:head>

<section class="stack-lg scroll-runway">
  <h1 class="heading-lg uppercase">Search</h1>
  <search class="stack-xs">
    <label class="label" for="library-search">Search library</label>
    <!-- svelte-ignore a11y_autofocus (Focus the primary input on the dedicated search page.) -->
    <input
      class="input"
      id="library-search"
      type="search"
      placeholder="Artists, albums, tracks"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      bind:value={searchState.query}
      oninput={(event) => {
        searchState.query = event.currentTarget.value;
        updateCriteria("replace");
      }}
      autofocus
    />
    <div class="search-filters" role="group" aria-label="Result types">
      {#each searchTypes as type}
        <button
          type="button"
          class="button search-filter"
          data-size="text"
          data-variant={selectedTypes.includes(type) ? "primary" : "secondary"}
          aria-pressed={selectedTypes.includes(type)}
          onclick={() => toggleType(type)}
        >
          {type === "artist" ? "Artist" : type === "album" ? "Album" : "Track"}
        </button>
      {/each}
    </div>
  </search>
  {#if libraryError}
    <div class="card stack-md">
      <h2 class="heading-sm">Library needs attention</h2>
      <p class="body">{libraryError}</p>
      {#if index.size > 0}<p class="body">Available music is still searchable below.</p>{/if}
      <div class="row-sm">
        <a class="button" data-variant="secondary" data-size="text" href="?/settings"
          >Open settings</a
        >
      </div>
    </div>
  {/if}
  <div class="stack-xl" aria-busy={!session.localReady}>
    {#if !session.localReady && index.size === 0}
      <div class="row-sm">
        <Loader />
        <p class="body">Loading your library…</p>
      </div>
    {:else if index.size === 0}
      {#if session.localReady}
        <div class="stack-md">
          <h2 class="heading-sm">
            {cache.savedAt === undefined
              ? "Connect your library"
              : session.offlineMode
                ? "No downloaded music to search."
                : "Your library is empty."}
          </h2>
          <p class="body">
            {cache.savedAt === undefined
              ? "Add your music server to start searching."
              : session.offlineMode
                ? "Download music from the library to search offline."
                : "Your music will appear here after synchronization."}
          </p>
          <div class="row-sm">
            <a
              class="button"
              data-variant="secondary"
              data-size="text"
              href={cache.savedAt === undefined ? "?/settings" : "?/library"}
              >{cache.savedAt === undefined ? "Open settings" : "Open library"}</a
            >
          </div>
        </div>
      {/if}
    {:else if !matches.query && !singleType}
      <p class="body text-secondary">
        Type to find music in your library.
        {#if selectedTypes.length > 1}Select one type to browse your library.{/if}
      </p>
    {:else if results.every((result) => result.total === 0)}
      <div class="stack-md">
        <h2 class="heading-sm">No matches found.</h2>
        <p class="body">Try another search or change the selected types.</p>
      </div>
    {:else}
      {#each results as { group, records, total }}
        {#if total > 0}
          <section class="stack-lg" aria-label={group}>
            <header class="row-md row-justify">
              <h2 class="heading-lg uppercase">{group}</h2>
              <span class="metadata text-subtle">{total}</span>
            </header>
            {#snippet resultRow(record: SearchRecord)}
              {@const track = group === "Tracks" ? cache.tracks.get(record.id) : undefined}
              <div
                class="menu-item track-row"
                aria-current={track && currentTrackId === track.id ? "true" : undefined}
              >
                <div class="row-sm">
                  <Artwork {covers} id={record.artworkId} size="sm" />
                  <div>
                    <p class="label">{record.title}</p>
                    <p class="caption text-secondary">{supportingText(group, record)}</p>
                  </div>
                </div>
                {#if record.href}
                  <a
                    class="button-quiet link-target"
                    href={record.href}
                    aria-label={record.title}
                    data-longpressfor="search-menu"
                    data-longpress="show-modal"
                    onfocus={() => selectMenu(group, record.id)}
                  ></a>
                {:else}
                  <button
                    class="button-quiet link-target"
                    aria-label={currentTrackId === record.id
                      ? `Toggle playback for ${record.title}`
                      : `Play ${record.title}`}
                    data-longpressfor="search-menu"
                    data-longpress="show-modal"
                    onfocus={() => selectMenu(group, record.id)}
                    onclick={() => playback.toggleTrack(record.id, trackContext(record.id))}
                  ></button>
                {/if}
                <div class="row-sm">
                  {#if track?.duration !== undefined}
                    <span class="metadata text-subtle">{formatDuration(track.duration)}</span>
                  {/if}
                  <button
                    class="button only-mobile"
                    data-variant="secondary"
                    commandfor="search-menu"
                    command="show-modal"
                    aria-label={`Open menu for ${record.title}`}
                    onclick={() => selectMenu(group, record.id)}
                  >
                    <Icon name="menu" />
                  </button>
                  <button
                    class="button only-desktop"
                    data-variant="secondary"
                    commandfor="search-menu-popover"
                    command="toggle-popover"
                    aria-label={`Open menu for ${record.title}`}
                    onclick={() => selectMenu(group, record.id)}
                  >
                    <Icon name="menu" />
                  </button>
                </div>
              </div>
            {/snippet}
            {#if singleType}
              {#key cache}
                {#key criteriaKey}
                  <VirtualList
                    items={records}
                    row={resultRow}
                    pinnedId={menuOpen ? menuItem?.id : undefined}
                  />
                {/key}
              {/key}
            {:else}
              <ul class="search-preview stack-sm">
                {#each records as record (record.id)}
                  <li>{@render resultRow(record)}</li>
                {/each}
              </ul>
            {/if}
            {#if !singleType && total > records.length}
              <div class="row-sm">
                <button
                  class="button"
                  data-size="text"
                  data-variant="secondary"
                  aria-label={`Show more ${group.toLowerCase()}`}
                  onclick={() => (searchState.limits[group] += 10)}>Show more</button
                >
              </div>
            {/if}
          </section>
        {/if}
      {/each}
    {/if}
  </div>
</section>

<dialog
  bind:this={sheet}
  onclose={() => menuVisibility(false)}
  ontoggle={(event) => menuVisibility(event.newState === "open")}
  id="search-menu"
  class="bottom-sheet"
  aria-labelledby="search-menu-title"
  closedby="any"
  data-swipedown="close"
>
  <span class="dialog-handle" aria-hidden="true"></span>
  {@render actions("search-menu", false)}
</dialog>
<div
  bind:this={popover}
  ontoggle={(event) => menuVisibility(event.newState === "open")}
  id="search-menu-popover"
  class="popover"
  popover="auto"
  role="dialog"
  aria-labelledby="search-menu-popover-title"
>
  {@render actions("search-menu-popover", true)}
</div>

{#snippet actions(target: string, isPopover: boolean)}
  <div class="stack-lg">
    <header class="row-md row-justify">
      <div class="row-md">
        <Artwork {covers} id={menuItem?.artworkId} size="lg" />
        <h2 id={`${target}-title`} class="heading-md">{menuItem?.title ?? ""}</h2>
      </div>
      <button
        class="button"
        commandfor={target}
        command={isPopover ? "hide-popover" : "close"}
        aria-label="Close menu"
      >
        <Icon name="cross" />
      </button>
    </header>
    <div class="stack-sm">
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          playMenu();
          dismissActions();
        }}
      >
        <Icon name="play" />
        <span>Play</span>
      </button>
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.enqueue(menuTrackIds, "next");
          dismissActions();
        }}
      >
        <Icon name="next" />
        <span>Play next</span>
      </button>
      <button
        class="menu-item"
        disabled={!menuTrackIds.length}
        onclick={() => {
          void playback.enqueue(menuTrackIds, "last");
          dismissActions();
        }}
      >
        <Icon name="plus" />
        <span>Play last</span>
      </button>
      <button
        class="menu-item"
        disabled={!menuTracks.length || menuDownloadStatus !== "idle"}
        onclick={() => {
          trackEngine.downloadMany(menuTracks.map((track) => track.id));
          dismissActions();
        }}
      >
        {#if menuDownloadStatus === "downloading"}
          <Loader />
        {:else}
          <Icon name={downloadPresentation[menuDownloadStatus].icon} />
        {/if}
        <span>{downloadPresentation[menuDownloadStatus].label}</span>
      </button>
    </div>
  </div>
{/snippet}

<style>
  .search-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 8px;
  }
  .search-filter {
    min-height: 44px;
    padding-inline: 16px;
    border: 2px solid transparent;
  }
  .search-filter[aria-pressed="true"] {
    border-color: var(--accent);
  }
  .search-preview {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .track-row > .row-sm:first-child,
  .track-row > .row-sm:first-child > div {
    min-inline-size: 0;
  }
  .track-row > .row-sm:last-child {
    flex-shrink: 0;
  }
</style>
