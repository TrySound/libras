<script module lang="ts">
  import fuzzysort from "fuzzysort";
  import type { Album, Artist, Track, FavouriteState } from "./schema";
  import type { Immutable } from "./cache.svelte";

  export function parseSearch(query: string) {
    const kinds = new Set<string>();
    let favourite = false;
    let directed = false;
    const text = query
      .trim()
      .split(/\s+/)
      .filter((token) => {
        const directive = token.toLowerCase();
        if ([":artist", ":album", ":track"].includes(directive)) {
          kinds.add(directive.slice(1));
          directed = true;
          return false;
        }
        if (directive === ":favourite") {
          favourite = true;
          directed = true;
          return false;
        }
        return true;
      })
      .join(" ");
    return { text, kinds, favourite, directed };
  }
  const kindFor = { Artists: "artists", Albums: "albums", Tracks: "tracks" } as const;

  const searchGroups = ["Artists", "Albums", "Tracks"] as const;

  type SearchGroup = (typeof searchGroups)[number];

  interface SearchRecord {
    id: string;
    title: string;
    artist: string;
    album: string;
    href?: string;
    artworkId?: string;
    unavailable?: boolean;
  }

  export function createSearchState(query = "") {
    const limit = parseSearch(query).directed ? 10 : 3;
    return { query, limits: { Artists: limit, Albums: limit, Tracks: limit } };
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
    favourites?: Immutable<FavouriteState>,
  ) {
    const eligibleTracks = [...tracks.values()].filter(
      (track) => !available || available(track.id),
    );
    const albumIds = new Set(eligibleTracks.map((track) => track.albumId));
    const eligibleAlbums = [...albums.values()].filter(
      (album) => !available || albumIds.has(album.id),
    );
    const artistIds = new Set([
      ...eligibleAlbums.flatMap((album) => album.artistIds),
      // A downloaded album remains browsable under every credited contributor,
      // including guests whose own track has not been downloaded.
      ...[...tracks.values()]
        .filter((track) => albumIds.has(track.albumId))
        .flatMap((track) => track.artistIds),
    ]);
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
    const membership = Object.fromEntries(
      searchGroups.map((group) => [
        group,
        new Set(favourites?.[kindFor[group]].map((item) => item.id)),
      ]),
    ) as Record<SearchGroup, Set<string>>;
    if (!available && favourites) {
      for (const group of searchGroups) {
        const ids = new Set(records[group].map((item) => item.id));
        for (const item of favourites[kindFor[group]]) {
          if (!ids.has(item.id)) {
            ids.add(item.id);
            records[group].push({
              ...item,
              artist: item.artist ?? "",
              album: "",
              unavailable: true,
            });
          }
        }
      }
    }
    const groupIndex = (group: SearchGroup) => {
      const prepare = (records: SearchRecord[]) => ({
        records,
        snapshot: fuzzysort.snapshot(records, { keys: ["title", "artist", "album"] }),
      });
      return {
        ordinary: prepare(records[group].filter((record) => !record.unavailable)),
        favourite: prepare(records[group].filter((record) => membership[group].has(record.id))),
      };
    };
    return {
      Artists: groupIndex("Artists"),
      Albums: groupIndex("Albums"),
      Tracks: groupIndex("Tracks"),
      size: Object.values(records).reduce((sum, group) => sum + group.length, 0),
    };
  }

  export function searchLibrary(index: ReturnType<typeof createSearchIndex>, query: string) {
    const parsed = parseSearch(query);
    query = query.trim().replace(/\s+/g, " ");
    const groups = searchGroups.map((group) => {
      const kind = kindFor[group].slice(0, -1);
      const eligible = !parsed.kinds.size || parsed.kinds.has(kind);
      const { records: candidates, snapshot } =
        index[group][parsed.favourite ? "favourite" : "ordinary"];
      // Retrieve matches explicitly without a library limit so equal scores can be
      // ordered deterministically before applying the UI limit.
      const matches = !eligible
        ? []
        : parsed.text
          ? [
              ...fuzzysort.go(parsed.text, snapshot, {
                limit: 0,
                // Keep consonant abbreviations such as “frmtn” → “Formation”.
                threshold: 0.2,
                scoreFn: (result) => result.score * (0.8 + 0.2 * result[0].score),
              }),
            ].sort(
              (a, b) =>
                b.score - a.score || (a.obj.id < b.obj.id ? -1 : a.obj.id > b.obj.id ? 1 : 0),
            )
          : parsed.directed
            ? [...candidates]
                .sort(
                  (a, b) =>
                    a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                )
                .map((obj) => ({ obj }))
            : [];
      return {
        group,
        total: matches.length,
        records: matches.map((result) => result.obj),
      };
    });
    return { query, groups, ...parsed };
  }
</script>

<script lang="ts">
  import Icon from "./icon.svelte";
  import FavouriteButton from "./ui/favourite-button.svelte";
  import { getContext } from "svelte";
  import type { Favourites } from "./favourites.svelte";
  import type { Cache } from "./cache.svelte";
  import type { Covers } from "./covers.svelte";
  import Artwork from "./ui/artwork.svelte";
  import Loader from "./ui/loader.svelte";
  import { formatDuration } from "./time";
  import type { TrackEngine } from "./track.svelte";
  import type { Session } from "./session.svelte";
  import type { Playback } from "./playback.svelte";

  const favourites = getContext<Favourites | undefined>("favourites");
  let {
    cache,
    covers,
    trackEngine,
    session,
    playback,
    appName = "Libras",
    state: searchState,
  }: {
    cache: Cache;
    covers: Covers;
    trackEngine: TrackEngine;
    session: Session;
    playback: Playback;
    state: SearchState;
    appName?: string;
  } = $props();

  const index = $derived(
    createSearchIndex(
      cache.artists,
      cache.albums,
      cache.tracks,
      session.offlineMode ? isAvailable : undefined,
      cache.favourites,
    ),
  );

  const matches = $derived(searchLibrary(index, searchState.query));
  const currentTrackId = $derived(cache.queue.tracks[cache.queue.index]);
  const libraryError = $derived(
    session.refreshError ||
      session.error ||
      (cache.reportingError ? "Some local data could not be restored or saved." : ""),
  );

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
    const item = matches.groups
      .find((result) => result.group === group)
      ?.records.find((record) => record.id === id);
    return item ? { ...item, group } : undefined;
  });

  const menuTracks = $derived.by(() => {
    if (!menuItem || menuItem.unavailable) return [];
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
    sheet.close();
    popover.hidePopover?.();
  }

  $effect(() => {
    if (!menuItem && menuSelection) {
      const wasOpen = sheet?.open || popover?.matches(":popover-open");
      if (wasOpen) dismissActions();
      // Consume the disappeared selection, even if its overlay was already dismissed.
      // Later background index changes must not steal the user's new focus.
      menuSelection = undefined;
      if (wasOpen) document.getElementById("library-search")?.focus({ preventScroll: true });
    }
  });

  function supportingText(group: SearchGroup, record: SearchRecord) {
    if (record.unavailable)
      return [record.artist, "Unavailable in your library"].filter(Boolean).join(" · ");
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
      oninput={(event) =>
        (searchState.limits = createSearchState(event.currentTarget.value).limits)}
      autofocus
    />
    <p class="caption text-secondary">Filter with :artist, :album, :track, or :favourite.</p>
  </search>
  {#if matches.favourite && (favourites?.loading || favourites?.error || cache.favouritesError || cache.favourites.fetchedAt === null)}
    <div class="card stack-sm" aria-busy={favourites?.loading}>
      <p class="caption">
        {favourites?.loading
          ? "Loading favourites…"
          : favourites?.error
            ? `Favourites need attention: ${favourites.error instanceof Error ? favourites.error.message : "Could not load favourites."}`
            : cache.favourites.fetchedAt === null
              ? "Favourites haven’t been loaded."
              : "Confirmed favourites could not be saved to this device cache."}
      </p>
      <a href="?/settings">Open settings</a>
    </div>
  {/if}
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
    {#if index.size === 0 && !matches.favourite}
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
    {:else if !matches.query}
      <p class="body text-secondary">Type to find music in your library.</p>
    {:else if results.every((result) => result.total === 0)}
      <div class="stack-md">
        <h2 class="heading-sm">
          {matches.favourite
            ? cache.favourites.fetchedAt === null
              ? "Favourites are not available yet."
              : !cache.favourites.artists.length &&
                  !cache.favourites.albums.length &&
                  !cache.favourites.tracks.length
                ? "No favourites yet."
                : "No matching favourites."
            : "No matches found."}
        </h2>
        <p class="body">
          {matches.favourite
            ? "Add favourites through item Actions, or change your search/filter."
            : "Try another artist, album, or track name."}
        </p>
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
                  {:else if !record.unavailable && group === "Tracks"}
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
            {#if total > records.length}
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
      <FavouriteButton
        overlayId={target}
        target={menuItem ? { kind: kindFor[menuItem.group], id: menuItem.id } : undefined}
      />
    </div>
  </div>
{/snippet}
