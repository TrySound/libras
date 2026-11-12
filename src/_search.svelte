<script module lang="ts">
  import fuzzysort from "fuzzysort";
  import type { Album, Artist, Track } from "./schema";
  import type { Immutable } from "./cache.svelte";

  export const searchTypes = ["artist", "album", "track"] as const;
  export type SearchType = (typeof searchTypes)[number];

  export function parseSearch(parameters: URLSearchParams) {
    const selected = parameters.getAll("type");
    return {
      query: parameters.get("q") ?? "",
      types: searchTypes.filter((type) => selected.includes(type)),
    };
  }

  /** Keep the route bare; encode only search criteria, never the full parameter collection. */
  export function searchHref(query = "", types: readonly SearchType[] = []) {
    const parameters = new URLSearchParams();
    for (const type of searchTypes) if (types.includes(type)) parameters.append("type", type);
    if (query) parameters.set("q", query);
    const suffix = parameters.toString();
    return `?/search${suffix ? `&${suffix}` : ""}`;
  }

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
  import Icon from "./icon.svelte";
  import { navigate, route } from "./router.svelte";
  import { onVisible } from "./viewport";
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
  }: {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playback: Playback;
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

  const criteria = $derived(parseSearch(route.parameters));
  const selectedTypes = $derived(criteria.types);
  const singleType = $derived(selectedTypes.length === 1);
  const matches = $derived(searchLibrary(index, criteria.query, singleType));
  // URL criteria and cache switches restart local batches and previews.
  const pageSize = 48;
  let limit = $derived.by(() => {
    void cache;
    void criteria;
    return pageSize;
  });
  let limits = $derived.by(() => {
    void cache;
    void criteria;
    return { Artists: 3, Albums: 3, Tracks: 3 };
  });

  function toggleType(type: SearchType) {
    const types = selectedTypes.includes(type)
      ? selectedTypes.filter((value) => value !== type)
      : [...selectedTypes, type];
    navigate(searchHref(criteria.query, types).slice(1) + window.location.hash);
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
        records: result.records.slice(0, singleType ? limit : limits[result.group]),
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

  function selectMenu(group: SearchGroup, id: string) {
    menuSelection = { cache, group, id };
  }

  let sheet: HTMLDialogElement;
  let popover: HTMLDivElement;

  function dismissActions() {
    sheet?.close();
    popover?.hidePopover?.();
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
  <div class="card stack-md">
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
        value={criteria.query}
        oninput={(event) =>
          navigate(
            searchHref(event.currentTarget.value, selectedTypes).slice(1) + window.location.hash,
            "replace",
          )}
        autofocus
      />
    </search>
    <div class="row-sm row-wrap" role="group" aria-label="Result types">
      {#each searchTypes as type}
        <button
          type="button"
          class="button"
          data-size="text"
          data-variant={selectedTypes.includes(type) ? "primary" : "secondary"}
          aria-pressed={selectedTypes.includes(type)}
          onclick={() => toggleType(type)}
        >
          {#if type === "artist"}Artist{:else if type === "album"}Album{:else}Track{/if}
        </button>
      {/each}
    </div>
  </div>
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
            <div class="stack-sm">
              {#each records as record (record.id)}
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
              {/each}
            </div>
            {#if singleType && total > records.length}
              {#key limit}
                <div
                  class="library-sentinel"
                  aria-hidden="true"
                  {@attach onVisible(() => (limit = Math.min(limit + pageSize, total)))}
                ></div>
              {/key}
            {:else if total > records.length}
              <div class="row-sm">
                <button
                  class="button"
                  data-size="text"
                  data-variant="secondary"
                  aria-label={`Show more ${group.toLowerCase()}`}
                  onclick={() => (limits = { ...limits, [group]: limits[group] + 10 })}
                  >Show more</button
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
  id="search-menu-popover"
  class="popover"
  popover="auto"
  role="dialog"
  aria-labelledby="search-menu-popover-title"
>
  {@render actions("search-menu-popover", true)}
</div>

{#snippet actions(target: string, isPopover: boolean)}
  <div class="stack-lg" class:container-md={!isPopover}>
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
