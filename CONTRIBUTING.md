# Contributing to Libras

Libras is a client-only Svelte + Vite app using the Subsonic API. See the [README](README.md) for features and getting started with the hosted app.

## Local development

Use Node.js 22 and the pnpm version specified in `package.json`.

```sh
pnpm install
pnpm dev
```

The Navidrome server must allow browser requests from the app's origin (CORS), and HTTPS should be used outside local development.

## Checks

Before submitting changes, run:

```sh
pnpm check
pnpm test
pnpm build
```

Use `pnpm format` to format the project. The pre-commit hook formats staged HTML, CSS, Svelte, and TypeScript files.

## CI and GitHub Pages

The CI workflow (`.github/workflows/ci.yml`) runs type checks, tests, and a production build for pull requests and pushes to `main`. A separate Pages workflow (`.github/workflows/pages.yml`) builds and deploys `main` to https://trysound.github.io/libras/ using a Pages artifact, without a separate branch. Both workflows can also be run manually; Pages deployment runs independently of CI.

In the repository's **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.

To preview the Pages build locally:

```sh
BASE_PATH=/libras/ pnpm build
pnpm preview
```

Open `/libras/` on the preview server. Normal local builds default to `/`. The Navidrome server must allow `https://trysound.github.io` through CORS and use HTTPS.

## Testing installation on Android

The production app is installable as a standalone PWA. It includes regular and maskable icons and an offline app shell. Service workers are disabled in development to avoid interfering with hot reload.

Build and serve it on the machine containing the project:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4173 --strictPort
```

If the project runs on the phone itself (for example, in Termux), open `http://localhost:4173` in Chrome. If it runs on a remote SSH server, run this **on the phone** in an SSH client that supports local forwarding:

```sh
ssh -N -L 4173:127.0.0.1:4173 user@your-server
```

Keep the preview server and tunnel running, then open `http://localhost:4173` on the phone. Use Chrome's **Install app / Add to home screen** option and launch the installed app from the home screen. Localhost is a secure-context exception; a remote or LAN deployment needs HTTPS. Vite preview is for testing, not production hosting.

The Navidrome server must be reachable **from the phone** and permit the frontend origin through CORS. Switching ports or hosts creates a different origin: saved authentication and downloaded music do not carry over automatically.

## State and synchronization architecture

`app.svelte` constructs the domain engines, `Network`, `Session`, and transitional `Memory`. UI and resource engines continue reading Memory. Its read-only library, queue, and artwork getters delegate to the selected account's reactive `Cache` without copying records; downloads are a derived row projection adding account/key fields for the unchanged UI. Memory owns no independently writable data collections. Direct UI cache access is deferred. Credentials, network clients, authenticated URLs, object URLs, and workflow state stay outside the cache.

| Owner | Responsibility |
| --- | --- |
| `Session` | Cache selection, credentials, connection lifecycle, local hydration, and startup/manual refresh coordination |
| `MetadataEngine` | Candidate fetching, server timestamp checks, refresh cancellation, and replacement of the selected cache's library |
| `Cache` | Account-scoped library, queue, image, and download hydration, validation, persistence, reactive collections, and derived relationships/artwork candidates |
| `QueueEngine` | Local commands, connection-scoped server reads/writes, upload ordering, and playback protection |
| `PlaybackEngine` | Audio resources, playback controls, local queue navigation, and Media Session |
| `CoverEngine` / `TrackEngine` | On-demand artwork/audio fetching, caching, scheduling, and resource ownership |
| `Network` | Configured connection capabilities, protocol normalization, and transport cancellation |

Cache collections are immutable by contract. Library replacement commits one JSON snapshot before publishing all related maps and freshness fields with one reactive assignment. Cache publishes one complete queue value before QueueEngine notifies explicit playback subscribers; Memory only proxies its fields. Runes provide UI reactivity, while methods and callbacks coordinate engines—no effects observe state to mutate another engine.

### Data flow

- **Startup:** select the saved account, restore local data, mark `Session.localReady`, then revalidate metadata and refresh the queue when online. Cached data remains usable while `Session.syncing` is true.
- **Refresh:** startup and Settings → Refresh library are the only routine pull triggers. Manual refresh forces metadata fetching; startup skips an unchanged library. There are no periodic refreshes, focus triggers, or automatic retries. Returning online attaches fresh capabilities without pulling.
- **First connection:** MetadataEngine fetches a candidate library without touching the current workspace. Session persists it into a separate cache, accepts the network connection, suspends playback, and selects the prepared cache. The queue is then fetched explicitly. Failed candidate fetching, persistence, or network acceptance leaves the old cache selected, including same-account reconnects.
- **Server snapshots:** MetadataEngine fetches a library and delegates replacement to Cache; it does not index or publish records. QueueEngine delegates incoming queue persistence/publication to `Cache.replaceQueue()` and notifies playback only after adoption. Failed saves do not publish incoming data. Server timestamp checks and queue occurrence-index matching stay beside their domain workflows. Subsonic-specific normalization stays in Network.
- **Queue commands:** local queue changes publish immediately and are persisted asynchronously. An explicit new online queue enables server writes for that session. Navigation and position updates preserve that permission; they cannot promote an offline queue into an upload after reconnecting. Successful uploads acknowledge only the sent revision; they do not save a second queue snapshot.
- **Offline/disconnect:** stop sync, abort connections and detach resource access, flush local checkpoints, and retain the selected workspace. Cached playback can continue. Account switches suspend playback before replacing data.

### Queue and lifecycle boundaries

`memory.queueTracks`, `queueIndex`, and `queuePosition` proxy the single local playback queue in Cache. An idle refresh persists the fetched queue before adopting it. A refresh during playing or paused playback leaves the local queue unchanged and does not retain the server response for later adoption. Another explicit refresh is needed to fetch it again.

Pending online writes are connection-scoped, not a durable outbox. Disconnect discards upload eligibility, not local data. No server replicas or upload markers are stored, and legacy queue records are not migrated. Local edits are optimistic, and position checkpoints can lag live playback. Consequently, Memory is a local projection plus live session state—not a guarantee that every displayed value has already reached disk or the server.

QueueEngine receives a configured queue connection and exposes ordinary `refresh()` and `flush()` commands. Cache owns local write ordering and revisions; QueueEngine uploads only a revision acknowledged by `Cache.flush()`, and successful uploads never trigger another disk write. Session calls `queue.activate()` after cache selection/loading to reset connection-scoped queue policy and notify playback; activation performs no hydration or persistence. MetadataEngine likewise exposes `setConnection()` and `refresh(force)` rather than preparation/commit/finish callbacks. It cancels obsolete traversals and preserves cached data on failure; refresh failures propagate to Session. Session owns cache-load cancellation and active-cache checks; disconnect keeps local loading alive, while destruction aborts it. Revision checks protect edits, connection generations protect network workflows, and file locks protect writes. They are not interchangeable. There is no cross-tab notification/synchronization layer.

Errors are separate: Session reports connection failures and non-blocking refresh failures; QueueEngine owns queue network errors and proxies Cache's queue storage error, which Session also exposes to the UI. Metadata restoration failures reject to Session, which reports them without blocking local queue restoration or online recovery; a successful metadata refresh clears that warning. MetadataEngine does not maintain separate UI status/error state. Background failures retain existing data. Artwork/audio remain on-demand resource operations rather than general server-state synchronization.

## Network boundary

`Network` is the application-facing server boundary. It privately owns the Subsonic SDK clients and exposes metadata, queue, artwork, and audio operations bound to one connection lifetime. Public connection handles contain only frozen account identity and an abort signal, not credentials or SDK methods. Copied or foreign handles cannot be accepted or used to acquire access.

Only metadata validation is available to a login candidate. Acceptance enables other operations and aborts the previous connection. Going offline aborts active and candidate connections; returning online creates a fresh connection. Session explicitly sequences persistence, engine attachment/detachment, and playback suspension—there is no lifecycle event bus. Browser-managed image/audio sources must be released explicitly; fetch cancellation alone cannot stop them.

Network owns remote requests, response mapping, authenticated URLs, and connection cancellation. Metadata's `readLibrary(signal)` traverses 500-album pages and fetches album tracks with up to six workers. Superseded workflows abort their requests without closing the shared connection; a failed traversal also cancels sibling requests. Network also resolves artist matching, synthetic artist IDs, relationships, and track flattening. MetadataEngine stages candidate fetches and delegates local data ownership to Cache; Session invokes refresh at startup or on manual request. Engines retain acquisition policy, download scheduling, and object URLs; Cache performs all local library, queue, artwork, and audio persistence. Audio responses stream directly to OPFS with both connection and job cancellation. Network's `createAuth()` normalizes the host and delegates salt/token generation to the SDK's `createSubsonicAuth()` helper, without enabling access or making requests. AuthStore only validates and persists credentials and last-account identity. Authentication storage keeps its existing token/salt format; its `Auth` type is inferred in `auth.ts`, separate from SDK types.

`NetworkTransportError` identifies a rejected fetch before a response is returned, preserving the original cause. The SDK accepts an injected fetch implementation so Network applies the same classification to SDK, artwork, and audio requests. HTTP status, protocol, parsing/body-consumption, and storage errors retain their original identities; cancellation is never wrapped. Session provides connection troubleshooting text only for this transport error, without claiming to diagnose CORS.

## Storage architecture and offline behavior

`src/cache.svelte.ts` owns library, queue, artwork, and download runtime/persisted data. Session creates an account cache for startup and a separate candidate cache for each explicit connection, selecting the latter only after persistence and network acceptance. Session calls `Cache.load()` directly and waits for local restoration before attaching network access. MetadataEngine neither loads nor selects caches and receives only a read-only view of the selection. A failed library load is reported without blocking queue/image restoration or online recovery. Engines use the selected cache; Memory proxies its collections and MetadataEngine proxies library freshness for existing consumers. Neither exposes a writable snapshot. Candidate caches load their local records before acceptance. Same-account reconnects first flush the selected cache, then preserve any additional queue edits made during candidate preparation.

The queue cache stores one `{ tracks, index, position }` value at `accounts/<account-hash>/queue.json`, separate from the library. `setQueue()` copies and validates the value, publishes immediately, and schedules a 300 ms debounced save with a five-second maximum wait. Position-only changes use `{ checkpoint: true }` to defer to the five-second checkpoint without repeatedly scheduling server uploads. Incoming queue snapshots use `replaceQueue()` to persist before publication; edits, playback activation, and connection changes cancel obsolete adoption. If cancellation arrives during atomic close, Cache checkpoints the still-visible queue again to repair disk state. `flush()` saves pending edits and returns the revision actually committed; edits made during that write remain dirty. `queueDirty`, `queueRevision`, and `queueError` expose local durability, not server upload eligibility. A newer disk timestamp causes a conflict rather than replacing the optimistic queue or acknowledging a save. Failed background writes remain visible and wait for another edit or explicit flush to retry.

`Cache.load()` restores library, queue, image records, and download records independently. It waits for all attempts, retains each successful result, and reports domain failures through `CacheLoadError`. Queue/image/download errors remain on `queueError`/`imagesError`/`downloadsError`, so a successful library refresh cannot hide them. Restoration never overwrites pending queue edits. There are no legacy queue reads or duplicate queue stores.

CoverEngine reads the selected Cache directly, and Memory's artwork getters proxy it without separate state. Cache derives `artistArtwork`, `albumArtwork`, and `trackArtwork` candidate maps from the library using the existing fallback order; no candidate references or library timestamps are persisted in its image catalog. Completed image records live in `accounts/<account-hash>/images.json`, and unique binary files live under the account's `files/` directory. `saveImage()` closes bytes before committing their catalog entry, publishes only after commit, and compares the previously observed file reference to avoid overwriting a competing replacement. A losing save returns no blob; callers can read the winning record through `readImage()`. Superseded and uncommitted binary files are removed best-effort; cancellation after catalog close never deletes committed bytes. Startup loads only records, with missing/incomplete bytes invalidated conditionally on access. Corrupt catalogs are preserved rather than silently replacing unrelated downloaded-image references.

Session calls `covers.activate()` when selecting a cache to discard old handles, cancel pending image commits, and release object URLs; it does not load data. `covers.refresh()` re-resolves existing handles after local hydration or library replacement without writing catalogs or checking metadata timestamps. CoverEngine owns explicit acquisition, shared in-flight reads/downloads, HTTP revalidation, authenticated fallback URLs, and browser object URLs. Disconnect retains cached sources while invalidating network work. Cache-only playback handles never fetch images. Late reads or downloads cannot publish resources into a different cache, including same-account reconnects.

TrackEngine reads and writes the selected Cache directly; it has no catalog, private completed-download index, or record-publication step. `accounts/<account-hash>/downloads.json` stores completed records with independent track descriptions, format, content type, unique filename, size, and completion time. Cache derives map keys using `downloadKey(trackId, format)`; account scope is stored once in the catalog. `readDownload()` lazily opens a File without copying audio into RAM, repairs missing/incomplete references conditionally, and can adopt a competing replacement. No unlisted or old audio files are adopted. `saveDownload()` streams the response into a unique account-local `.audio` file, then commits its record before publication. Per-download Web Locks cover the disk recheck and transfer; different downloads stream concurrently, sharing only short catalog operations. A completed winner is reused and its unused response cancelled. Failed/uncommitted files are removed; cancellation during catalog close retains committed bytes without late publication. Cross-tab serialization requires Web Locks; unique filenames still prevent overwriting another writer's bytes when locks are unavailable. The old shared `tracks/downloads.json`, hashed audio files, and orphan adoption paths are no longer used or migrated; download audio again to populate the account cache.

Session calls `tracks.activate()` after selecting a cache to cancel old jobs/source requests and release its object URL. Activation performs no I/O; Cache owns hydration, and TrackEngine proxies `downloadsLoading` and storage errors. Pending reads are ordered behind hydration. TrackEngine retains FIFO scheduling, bounded concurrency (three by default), duplicate-job promises, connection/job cancellation, codec selection, MP3 fallback, offset streaming, and object URL lifetimes. Disconnect preserves the active cached source; switching caches invalidates it even for the same account. Download listings work without library metadata; status reads use reactive records without file access, and missing bytes are repaired on acquisition rather than scanned at startup.

`src/storage.ts` and its domain stores are removed. Cache owns local publication, file I/O, and write ordering; engines own browser resources and network policy. Memory's download rows are a read-only derived projection, not another persisted index. Files are acquired lazily; no interchangeable backend abstraction is needed.

- The service worker precaches only the production app shell, manifest, and install icons. The style guide is not available offline.
- Subsonic API requests, artwork, and audio streams are not runtime-cached by the service worker. Cache persists metadata, queue, artwork, and downloads. Engines decide when to acquire remote data.
- Cache library snapshots, queue state, image records, and the downloads catalog share `src/json-store.ts`: validated JSON reads, serialized read–modify–write operations, named Web Locks, atomic replacement, and optional stale-write cancellation before commit. Cache owns persisted-record validation and atomic conflict comparisons; engines interpret results and decide subsequent workflow. Corrupt files are preserved by default; library and queue explicitly retain their repair-on-write policies. Cache owns image and audio files; engines own browser object URLs.
- Authentication lives under `navidrome-auth` in localStorage. `navidrome-account` contains only the last selected host and username, allowing startup to restore OPFS data without credentials. Disconnect preserves this identity and persists `navidrome-offline-mode=true`; only a successful explicit connection unlocks online browsing. Existing saved authentication is migrated to a non-secret account record at startup.
- The library is one OPFS snapshot at `accounts/<account-hash>/library.json`, with normalized artist, album, and track arrays. Cache reconstructs lookup maps and sorted relationships automatically. Account hashes use a JSON-encoded host/username tuple. The snapshot restores before network revalidation, stays visible during refresh, and is replaced only after a complete validated save. No credentials or derived indexes are stored in it. The former `metadata/<account-hash>.json` format is not read or migrated; connect online to populate the new cache.
- Artwork uses `accounts/<account-hash>/images.json` for completed image records, file sizes, MIME types, and HTTP validators. Candidate lists are derived from the library, so metadata replacement retains the same image collection without rewriting its catalog. Web Locks serialize catalog updates where available. Previous `images/` catalogs, image files, and sidecars are left untouched, not migrated; download artwork on demand while online to populate the new cache.
- The queue persists to `accounts/<account-hash>/queue.json`: local ordered IDs, occurrence index, position, and timestamp. Old `queue/<account-hash>.json` records are not read or migrated. Restoration needs no credentials or autoplay, even when metadata is unavailable. Queue commands are debounced by 300 ms; playback position is checkpointed locally every five seconds, and pause/hide/flush saves the latest state. Newer disk records produce storage errors rather than successful acknowledgements; blocked writes are not uploaded. Abrupt browser termination may lose changes since the last completed write.
- Playback resolves queue IDs through metadata on demand. Missing metadata and Offline Library restrictions hide unavailable entries without deleting IDs or resetting the saved selection/position. Row actions and next/previous navigation use original queue indexes, preserving duplicate occurrences and skipping unavailable tracks. Only explicit queue edits change membership; incomplete metadata is never uploaded as a shortened queue. Downloads retain independent track descriptions.
- The old IndexedDB metadata cache is no longer read or migrated. Connect online once to populate the new snapshot. Downloaded audio, artwork, and saved authentication are not removed.
- **Settings → Downloads** lists active downloads, queued tracks, and completed files newest-first. Downloads run with up to three concurrent transfers. Playback does not wait for downloads when seeking or resuming.
- Audio records live in `accounts/<account-hash>/downloads.json`, and binary files live in the account's `files/` directory. Records contain neither credentials nor active/queued jobs. Listings restore without library metadata or eager binary reads. Failed writes remove their unique uncommitted files; committed bytes survive cancellation during catalog close. Old `tracks/` data remains untouched but is no longer adopted.
- Cached tracks and seeks within the current audio buffer use local seeking. Original-file streams also use native seeking within the browser's advertised `seekable` ranges, allowing HTTP byte-range requests without restarting transcoding. If setting the native seek position throws, playback falls back to an offset stream. Transcoded streams do not trust unbuffered seekable ranges. Uncached resumes and other unbuffered seeks request an MP3 stream with Subsonic `timeOffset` rather than downloading the entire track first. The player translates stream-relative time into full-track position and uses library metadata for full duration. This depends on the server honoring `timeOffset`; verify against Navidrome when testing. Playback never starts a separate background audio download; offline downloads are explicit user actions. Previously downloaded tracks remain available for local playback. Offset streams are never saved as complete downloads.
- First visit online so installation and shell caching can complete. Download music in the app before testing Offline Library mode.
- Test Settings refresh/disconnect, reload after disconnect, failed reconnect while forced offline, and reconnect to another account with overlapping track IDs. Saved credentials must be gone after disconnect; metadata, artwork, audio, and queue must remain usable offline. Check cancellation during both server requests and connection persistence. App settings DOM tests cover read-only actions, disabled refresh, forced-offline connection, credential input clearing, and late completions.
- A new version adds a dot to the settings button and a persistent **Update now** action in Settings. There is no update popup or dismiss action. The updater remains mounted across route changes, so navigating away does not clear availability. Nothing reloads automatically during playback; choosing Update now explicitly reloads the app and interrupts playback. Setup errors and retryable update failures are also shown in Settings.
- Updates are checked when the app becomes visible and hourly while visible and online.

## Testing app updates

To test updates, leave the installed app open, change the app, run `pnpm build` again, then return to the app to trigger a check. Chrome DevTools' Application panel can inspect the manifest, service worker, and caches. Clear site data or unregister the worker when testing a completely fresh installation (clearing site data also deletes saved app data).
