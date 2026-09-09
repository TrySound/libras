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

## Shared memory migration

`Memory` is being adopted incrementally. Metadata and queue data are integrated: `app.svelte` owns one instance, `MetadataEngine` validates/restores/refreshes data and synchronously replaces its top-level readonly maps, and `QueueEngine` owns writes to `queueTracks`, `queueIndex`, and `queuePosition`. The UI reads these fields directly, with no selector layer. Published records, relationship arrays, and queue lists are immutable by type contract.

Statuses, errors, validation, persistence, and timestamps remain engine-owned. The metadata engine retains no separate entity snapshot, lookup index, or data getters; callers and tests read Memory directly. CoverEngine no longer consumes metadata snapshots; it reads Memory maps and only uses the metadata engine's `savedAt` timestamp for catalog reconciliation. Queue statuses/errors, persistence, synchronization, and conflict handling remain in `QueueEngine`; queue data getters have been removed. All queue fields are published before synchronous subscribers are notified, and position updates do not replace the track list. Playback now reads metadata and queue data directly from Memory and depends on QueueEngine only for commands and synchronous notifications. Playback statuses/errors, duration, audio resources, stream offsets, and media-session handling remain in PlaybackEngine. Completed downloads now live in `memory.downloads`, keyed by the existing account/track/format key; the catalog can contain records from multiple accounts, while playable-track checks use the selected account. TrackEngine keeps active jobs, FIFO ordering, errors, and scheduling (there is no playback-priority download path), and the UI combines its job summaries with completed records read directly from Memory. Local audio lookup and MP3 fallback use account identity without requiring credentials; authenticated URLs are built only for network requests and must match the selected account. The storage adapter retains its internal catalog index and existing locking/validation rules. Artwork catalogs now publish `images`, `artistArtwork`, `albumArtwork`, and `trackArtwork` maps into Memory. Their records and reference lists are replaced rather than mutated. CoverEngine retains loading jobs, errors, catalog version bookkeeping, file access, and object URL ownership; `ensureArtistCover`, `ensureAlbumCover`, `ensureTrackCover`, and `ensureCover` explicitly acquire lazy resources. Reading Memory or an existing resource handle does not start I/O. Authenticated URLs and object URLs never enter Memory. MetadataEngine, QueueEngine, and TrackEngine require explicit Memory injection; they never create hidden standalone instances. The combined downloads getter and playback's unused selection getter have been removed. `Session` owns startup ordering, authentication/client reuse, connection and refresh errors, offline preference, and stale-operation guards. It explicitly restores the workspace, attaches cached playback, and revalidates metadata; it does not observe metadata status through an effect. MetadataEngine and QueueEngine client/network setters only configure policy and invalidate obsolete network work. Callers explicitly restore accounts, call metadata `revalidate()` (timestamp-aware) or `refresh()` (forced), and request queue `synchronize()`. Queue edit/checkpoint scheduling remains engine-owned. Session refresh reuses the current client, and offline changes apply network policy once without rebuilding an established workspace. Credential inputs, connected settings, and navigation remain in `app.svelte`, using a connection card with always-visible controls. Credentials, clients, and operational state stay outside Memory. Disconnect removes authentication, aborts the active client and download jobs, releases network sources, and forces offline mode without resetting Memory or deleting cached files. Already cached playback can continue; account changes still suspend playback before switching workspaces. Explicit reconnect validates a candidate via `prepareConnection()` without changing the offline workspace, then persists with `saveConnection()` and publishes with `acceptConnection()` after acceptance. Failed validation or persistence leaves the previous workspace selected. Session coordinates account transitions through the existing engine restore/publication APIs. Shared schemas and inferred types live in `src/schema.ts`, imported directly from their defining module.

## Storage architecture and offline behavior

- The service worker precaches only the production app shell, manifest, and install icons. The style guide is not available offline.
- Subsonic API requests, artwork, and audio streams are not runtime-cached by the service worker. Metadata, artwork, and downloads remain owned by the existing engines.
- Metadata, queue state, cover catalogs, and the downloads catalog share `src/json-store.ts`: validated JSON reads, serialized read–modify–write operations, named Web Locks, atomic replacement, and optional stale-write cancellation before commit. Schemas and conflict policies stay in the engines. Corrupt files are preserved by default; metadata and queue explicitly retain their repair-on-write policies. Binary audio/image files remain engine-owned.
- Authentication lives under `navidrome-auth` in localStorage. `navidrome-account` contains only the last selected host and username, allowing startup to restore OPFS data without credentials. Disconnect preserves this identity and persists `navidrome-offline-mode=true`; only a successful explicit connection unlocks online browsing. Existing saved authentication is migrated to a non-secret account record at startup.
- Metadata is a complete OPFS snapshot at `metadata/<account-hash>.json`, with normalized artist, album, and track arrays. Tracks reference artists and albums by ID; runtime maps provide lookups and sorted relationships. The snapshot restores at startup before network connection/revalidation, stays visible during refresh, and is replaced only after a complete validated save. No credentials are stored in it.
- Artwork has an account-scoped OPFS catalog at `images/<account-hash>.json`: precomputed artist/album/track references plus completed image records, file sizes, MIME types, and HTTP validators. Startup checks saved files once; cache flags and fallback selection then use memory maps, with image bytes loaded lazily. Metadata replacements explicitly rebuild references while retaining downloaded images. Catalog writes use Web Locks where available, and playback requests cached artwork only.
- Previous image files and per-image JSON sidecars are left untouched, not migrated. Artwork is downloaded into the new catalog on demand when online; old files alone no longer provide offline artwork.
- The queue persists to `queue/<account-hash>.json` in OPFS: ordered track IDs, selected occurrence index, position in seconds, and a pending-sync marker. It restores for the selected account without credentials or autoplay, even when metadata is unavailable. Offline edits take precedence over the server queue on reconnect; otherwise the cached queue remains visible while `getPlayQueue` revalidates it. Queue changes are debounced, playback position is checkpointed locally every five seconds, and pause/hide/flush saves the latest state. A newer disk record causes a storage conflict rather than a successful-save acknowledgement; the known-stale queue is not uploaded until a subsequent local write succeeds. Abrupt browser termination may lose changes since the last completed write.
- Playback resolves queue IDs through metadata on demand. Missing metadata and Offline Library restrictions hide unavailable entries without deleting IDs or resetting the saved selection/position. Row actions and next/previous navigation use original queue indexes, preserving duplicate occurrences and skipping unavailable tracks. Only explicit queue edits change membership; incomplete metadata is never uploaded as a shortened queue. Downloads retain independent track descriptions.
- The old IndexedDB metadata cache is no longer read or migrated. Connect online once to populate the new snapshot. Downloaded audio, artwork, and saved authentication are not removed.
- **Settings → Downloads** lists active downloads, queued tracks, and completed files newest-first. Downloads run with up to three concurrent transfers. Playback does not wait for downloads when seeking or resuming.
- Audio lives in OPFS under `tracks/`. The adjacent `downloads.json` is a validated list of completed file references, track metadata, account scope, format, size, and completion date; it contains neither credentials nor active/queued jobs. The engine loads it into a map and serializes catalog writes. Per-audio-file Web Locks cover the cache recheck, binary write, and catalog commit: a later writer reuses a completed download and cancels its unused response. Failed writes preserve nonempty files, including recoverable orphans. Cross-tab serialization requires Web Locks; without them, failed writes also retain empty placeholders to avoid racing another writer's close.
- Existing hashed audio files are adopted into the catalog when matched against library metadata, retaining their file modification dates. Files that cannot be matched remain untouched. The saved catalog can be listed without reloading the music library; missing file references are removed when the catalog opens.
- Cached tracks and seeks within the current audio buffer use local seeking. Original-file streams also use native seeking within the browser's advertised `seekable` ranges, allowing HTTP byte-range requests without restarting transcoding. If setting the native seek position throws, playback falls back to an offset stream. Transcoded streams do not trust unbuffered seekable ranges. Uncached resumes and other unbuffered seeks request an MP3 stream with Subsonic `timeOffset` rather than downloading the entire track first. The player translates stream-relative time into full-track position and uses library metadata for full duration. This depends on the server honoring `timeOffset`; verify against Navidrome when testing. Playback never starts a separate background audio download; offline downloads are explicit user actions. Previously downloaded tracks remain available for local playback. Offset streams are never saved as complete downloads.
- First visit online so installation and shell caching can complete. Download music in the app before testing Offline Library mode.
- Test Settings refresh/disconnect, reload after disconnect, failed reconnect while forced offline, and reconnect to another account with overlapping track IDs. Saved credentials must be gone after disconnect; metadata, artwork, audio, and queue must remain usable offline. Check cancellation during both server requests and connection persistence. App settings DOM tests cover read-only actions, disabled refresh, forced-offline connection, credential input clearing, and late completions.
- A new version adds a dot to the settings button and a persistent **Update now** action in Settings. There is no update popup or dismiss action. The updater remains mounted across route changes, so navigating away does not clear availability. Nothing reloads automatically during playback; choosing Update now explicitly reloads the app and interrupts playback. Setup errors and retryable update failures are also shown in Settings.
- Updates are checked when the app becomes visible and hourly while visible and online.

## Testing app updates

To test updates, leave the installed app open, change the app, run `pnpm build` again, then return to the app to trigger a check. Chrome DevTools' Application panel can inspect the manifest, service worker, and caches. Clear site data or unregister the worker when testing a completely fresh installation (clearing site data also deletes saved app data).
