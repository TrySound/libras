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
  }

  export function createSearchState() {
    return { query: "", limits: { Artists: 3, Albums: 3, Tracks: 3 } };
  }

  type SearchState = ReturnType<typeof createSearchState>;

  function availableTrackIds(
    tracks: readonly Immutable<Track>[],
    isAvailable: (id: string) => boolean,
  ) {
    return tracks.filter((track) => isAvailable(track.id)).map((track) => track.id);
  }

  const downloadPresentation = {
    idle: { icon: "download", label: "Download" },
    downloaded: { icon: "check", label: "Downloaded" },
    queued: { icon: "clock", label: "Queued" },
    downloading: { icon: "loading", label: "Downloading…" },
  };

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
    const artistIds = new Set(eligibleAlbums.map((album) => album.artistId));
    const artistPath = (id: string) => `#/library/artist/${encodeURIComponent(id)}`;
    const records: Record<SearchGroup, SearchRecord[]> = {
      Artists: [...artists.values()]
        .filter((artist) => !available || artistIds.has(artist.id))
        .map((artist) => ({
          id: artist.id,
          title: artist.name,
          artist: "",
          album: "",
          href: artistPath(artist.id),
        })),
      Albums: eligibleAlbums.map((album) => ({
        id: album.id,
        title: album.title,
        artist: artists.get(album.artistId)?.name ?? "",
        album: "",
        href: `${artistPath(album.artistId)}/album/${encodeURIComponent(album.id)}`,
      })),
      Tracks: eligibleTracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artistName ?? artists.get(track.artistId)?.name ?? "",
        album: albums.get(track.albumId)?.title ?? "",
      })),
    };
    const snapshot = (group: SearchGroup) =>
      fuzzysort.snapshot(records[group], {
        keys: ["title", "artist", "album"],
      });
    return {
      Artists: snapshot("Artists"),
      Albums: snapshot("Albums"),
      Tracks: snapshot("Tracks"),
      size: Object.values(records).reduce((sum, group) => sum + group.length, 0),
    };
  }

  export function searchLibrary(index: ReturnType<typeof createSearchIndex>, query: string) {
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
        total: matches.length,
        records: matches.map((result) => result.obj),
      };
    });
    return { query, groups };
  }
</script>

<script lang="ts">
  import type { Cache } from "./cache.svelte";
  import type { CoverEngine } from "./cover.svelte";
  import type { TrackEngine } from "./track.svelte";
  import type { Session } from "./session.svelte";
  import type { PlaybackController } from "./playback-controller.svelte";
  import { onVisible } from "./viewport";

  let {
    cache,
    coverEngine,
    trackEngine,
    session,
    playback,
    state: searchState,
  }: {
    cache: Cache;
    coverEngine: CoverEngine;
    trackEngine: TrackEngine;
    session: Session;
    playback: PlaybackController;
    state: SearchState;
  } = $props();

  const index = $derived(
    createSearchIndex(
      cache.artists,
      cache.albums,
      cache.tracks,
      session.offlineMode ? isAvailable : undefined,
    ),
  );

  const matches = $derived(searchLibrary(index, searchState.query));

  const results = $derived(
    matches.groups.map((result) => ({
      ...result,
      records: result.records.slice(0, searchState.limits[result.group]),
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
    return item ? { group, id, title: "name" in item ? item.name : item.title } : undefined;
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

  function playMenu() {
    if (!menuItem) return;
    if (menuItem.group === "Tracks") play(menuItem.id);
    else void playback.replaceQueueAndPlay(menuTrackIds);
  }

  function play(id: string) {
    const track = cache.tracks.get(id);
    if (!track) return;
    const ids = availableTrackIds(cache.albumTracks.get(track.albumId) ?? [], isAvailable);
    if (ids.includes(id)) void playback.replaceQueueAndPlay(ids, ids.indexOf(id));
  }
</script>

<section class="stack-md">
  <div class="view stack-md">
    <h1 class="type-heading">Search</h1>
    <div class="stack-sm" role="search">
      <label for="library-search">Search artists, albums, and tracks</label>
      <!-- svelte-ignore a11y_autofocus (Focus the primary input on the dedicated search page.) -->
      <input id="library-search" type="search" bind:value={searchState.query} autofocus />
    </div>
  </div>
  {#if !session.localReady}
    <p class="view" role="status">Restoring local library…</p>
  {/if}
  {#if index.size === 0}
    {#if session.localReady}
      <p class="view" role="status">
        {session.offlineMode ? "No downloaded music to search." : "Your library is empty."}
      </p>
    {/if}
  {:else if !matches.query}
    <p class="view text-muted" role="status">Type to find music in your library.</p>
  {:else if results.every((result) => result.total === 0)}
    <p class="view" role="status">No matches found.</p>
  {:else}
    {#each results as { group, records, total }}
      {#if total > 0}
        <section class="stack-sm" aria-label={group}>
          <h2 class="view type-heading">
            {group} <span class="type-small text-muted">{total}</span>
          </h2>
          <div class="wings">
            {#each records as record (record.id)}
              {@const cover =
                group === "Artists"
                  ? coverEngine.ensureArtistCover(record.id)
                  : group === "Albums"
                    ? coverEngine.ensureAlbumCover(record.id)
                    : coverEngine.ensureTrackCover(record.id)}
              <div class="wings-item row-button" {@attach onVisible(cover.load)}>
                {#if record.href}
                  <a
                    class="linkarea"
                    href={record.href}
                    aria-label={record.title}
                    data-longpressfor="search-menu"
                    data-longpress="show-modal"
                    onfocus={() => selectMenu(group, record.id)}
                  ></a>
                {:else}
                  <button
                    class="linkarea"
                    aria-label={`Play ${record.title}`}
                    data-longpressfor="search-menu"
                    data-longpress="show-modal"
                    onfocus={() => selectMenu(group, record.id)}
                    onclick={() => play(record.id)}
                  ></button>
                {/if}
                <span class="cover" data-size="md" aria-hidden="true">
                  {#if cover.source}<img src={cover.source} alt="" />
                  {:else}<svg width="20" height="20"><use href="#icon-music"></use></svg>{/if}
                </span>
                <span class="stack-xs">
                  <strong class="type-title">{record.title}</strong>
                  <span class="type-small text-muted"
                    >{[record.artist, record.album].filter(Boolean).join(" — ")}</span
                  >
                </span>
                <button
                  class="icon-button"
                  data-size="sm"
                  data-variant="ghost"
                  commandfor="search-menu"
                  command="show-modal"
                  aria-label={`Open menu for ${record.title}`}
                  title={`Open menu for ${record.title}`}
                  onclick={() => selectMenu(group, record.id)}
                >
                  <svg aria-hidden="true" width="20" height="20"><use href="#icon-menu"></use></svg>
                </button>
              </div>
            {/each}
          </div>
          {#if total > records.length}
            <div class="view">
              <button
                class="button"
                data-size="sm"
                data-variant="neutral"
                aria-label={`Show more ${group.toLowerCase()}`}
                onclick={() => (searchState.limits[group] += 10)}>Show more</button
              >
            </div>
          {/if}
        </section>
      {/if}
    {/each}
  {/if}
</section>

<dialog
  id="search-menu"
  class="action-menu"
  aria-labelledby="search-menu-title"
  closedby="closerequest"
  data-swipedown="close"
  onclick={(event) => event.currentTarget.close()}
>
  <div class="wings">
    <header class="topbar wings-item">
      <button class="icon-button" data-size="sm" data-variant="ghost" title="Close menu">
        <svg class="self-center" aria-hidden="true" width="20" height="20">
          <use href="#icon-chevron-down"></use>
        </svg>
      </button>
      <span id="search-menu-title" class="type-title">{menuItem?.title ?? ""}</span>
    </header>
    <button class="wings-item row-button" disabled={!menuTrackIds.length} onclick={playMenu}>
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-play"></use>
      </svg>
      <span>Play</span>
    </button>
    <button
      class="wings-item row-button"
      disabled={!menuTrackIds.length}
      onclick={() => void playback.enqueue(menuTrackIds, "next")}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-next"></use>
      </svg>
      <span>Play next</span>
    </button>
    <button
      class="wings-item row-button"
      disabled={!menuTrackIds.length}
      onclick={() => void playback.enqueue(menuTrackIds, "last")}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href="#icon-plus"></use>
      </svg>
      <span>Play last</span>
    </button>
    <button
      class="wings-item row-button"
      disabled={!menuTracks.length || menuDownloadStatus !== "idle"}
      onclick={() => menuTracks.forEach((track) => void trackEngine.download(track.id))}
    >
      <svg class="self-center" aria-hidden="true" width="20" height="20">
        <use href={`#icon-${downloadPresentation[menuDownloadStatus].icon}`}></use>
      </svg>
      <span>{downloadPresentation[menuDownloadStatus].label}</span>
    </button>
  </div>
</dialog>
