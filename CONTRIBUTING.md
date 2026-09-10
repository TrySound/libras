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

`app.svelte` constructs one `Memory`, the domain engines, `Network`, and `Session`. UI views derive from Memory and engine rune state; they do not render server responses directly. Credentials, network clients, authenticated URLs, object URLs, and workflow state stay outside Memory.

| Owner | Responsibility |
| --- | --- |
| `Session` | Account selection, configured Storage instances, credentials, connection lifecycle, local hydration, and startup/manual refresh coordination |
| `MetadataEngine` | Candidate fetching and complete metadata refresh: timestamp checks, persistence, indexing, and Memory publication |
| `QueueEngine` | Complete queue workflow: local commands, server reads/writes, persistence, ordering, and playback protection |
| `PlaybackEngine` | Audio resources, playback controls, local queue navigation, and Media Session |
| `CoverEngine` / `TrackEngine` | On-demand artwork/audio fetching, caching, scheduling, and resource ownership |
| `Network` | Configured connection capabilities, protocol normalization, and transport cancellation |
| `Storage` | Account-scoped file access, persisted-data validation, locks, and safe writes |

Memory contains immutable-by-contract records and map replacements. Metadata publishes all related maps synchronously; queue fields are published before explicit playback subscribers run. Runes provide UI reactivity, while methods and callbacks coordinate engines—no effects observe state to mutate another engine.

### Data flow

- **Startup:** select the saved account, restore local data, mark `Session.localReady`, then revalidate metadata and refresh the queue when online. Cached data remains usable while `Session.syncing` is true.
- **Refresh:** startup and Settings → Refresh library are the only routine pull triggers. Manual refresh forces metadata fetching; startup skips an unchanged library. There are no periodic refreshes, focus triggers, or automatic retries. Returning online attaches fresh capabilities without pulling.
- **First connection:** MetadataEngine fetches a candidate library without touching the current workspace, then persists it; Session accepts the connection and selects the account; MetadataEngine publishes it. The queue is then fetched explicitly. Failed candidate preparation leaves the old workspace intact.
- **Server snapshots:** MetadataEngine and QueueEngine each own a direct fetch → persist → publish workflow. Failed saves do not publish the incoming snapshot. Metadata timestamp checks and queue occurrence-index matching stay beside their domain workflows. Subsonic-specific normalization stays in Network.
- **Queue commands:** local queue changes publish immediately and are persisted asynchronously. An explicit new online queue enables server writes for that session. Navigation and position updates preserve that permission; they cannot promote an offline queue into an upload after reconnecting. Successful uploads acknowledge only the sent revision; they do not save a second queue snapshot.
- **Offline/disconnect:** stop sync, abort connections and detach resource access, flush local checkpoints, and retain the selected workspace. Cached playback can continue. Account switches suspend playback before replacing data.

### Queue and lifecycle boundaries

`memory.queueTracks`, `queueIndex`, and `queuePosition` are the single local playback queue. An idle refresh persists the fetched queue before adopting it. A refresh during playing or paused playback leaves the local queue unchanged and does not retain the server response for later adoption. Another explicit refresh is needed to fetch it again.

Pending online writes are connection-scoped, not a durable outbox. Disconnect discards upload eligibility, not local data. Legacy `pendingSync` values are accepted and discarded on read; new records omit the field. Local edits are optimistic, and position checkpoints can lag live playback. Consequently, Memory is a local projection plus live session state—not a guarantee that every displayed value has already reached disk or the server.

QueueEngine receives a configured queue connection and exposes ordinary `refresh()` and `flush()` commands. Its write ordering and revision checks are private; there is no cross-engine preparation/commit protocol or synchronization callback. MetadataEngine likewise exposes `setConnection()` and `refresh(force)` rather than preparation/commit/finish callbacks. It cancels obsolete traversals and preserves cached data on failure; refresh failures propagate to Session. Account-generation checks protect restoration, revision checks protect edits, connection generations protect network workflows, and Storage locks protect file writes. They are not interchangeable. There is no cross-tab notification/synchronization layer.

Errors are separate: Session reports connection failures and non-blocking refresh failures; QueueEngine owns queue network and storage errors, which Session also exposes to the UI. Metadata restoration failures reject to Session, which reports them without blocking local queue restoration or online recovery; a successful metadata refresh clears that warning. MetadataEngine does not maintain separate UI status/error state. Background failures retain existing data. Artwork/audio remain on-demand resource operations rather than general server-state synchronization.

## Network boundary

`Network` is the application-facing server boundary. It privately owns the Subsonic SDK clients and exposes metadata, queue, artwork, and audio operations bound to one connection lifetime. Public connection handles contain only frozen account identity and an abort signal, not credentials or SDK methods. Copied or foreign handles cannot be accepted or used to acquire access.

Only metadata validation is available to a login candidate. Acceptance enables other operations and aborts the previous connection. Going offline aborts active and candidate connections; returning online creates a fresh connection. Session explicitly sequences persistence, engine attachment/detachment, and playback suspension—there is no lifecycle event bus. Browser-managed image/audio sources must be released explicitly; fetch cancellation alone cannot stop them.

Network owns remote requests, response mapping, authenticated URLs, and connection cancellation. Metadata's `readLibrary(signal)` traverses 500-album pages and fetches album tracks with up to six workers. Superseded workflows abort their requests without closing the shared connection; a failed traversal also cancels sibling requests. Network also resolves artist matching, synthetic artist IDs, relationships, and track flattening. MetadataEngine stages persisted snapshots, builds local indexes, and publishes them; Session invokes refresh at startup or on manual request. Engines retain cache policy, download scheduling, persistence orchestration, and object URLs; Storage performs file I/O. Audio responses stream directly to OPFS with both connection and job cancellation. Network's `createAuth()` normalizes the host and delegates salt/token generation to the SDK's `createSubsonicAuth()` helper, without enabling access or making requests. AuthStore only validates and persists credentials and last-account identity. Authentication storage keeps its existing token/salt format; its `Auth` type is inferred in `auth.ts`, separate from SDK types.

`NetworkTransportError` identifies a rejected fetch before a response is returned, preserving the original cause. The SDK accepts an injected fetch implementation so Network applies the same classification to SDK, artwork, and audio requests. HTTP status, protocol, parsing/body-consumption, and storage errors retain their original identities; cancellation is never wrapped. Session provides connection troubleshooting text only for this transport error, without claiming to diagnose CORS.

## Storage architecture and offline behavior

`src/storage.ts` contains immutable account-configured `Storage` instances and persisted snapshot types. Session creates and caches `new Storage(account)` and distributes stable capabilities: `storage.metadata`, `storage.queue`, `storage.artwork`, and `storage.audio`. Each domain store lazily acquires its files/directories. No inheritance or interchangeable backend abstraction is needed.

Metadata saves return the winning snapshot; queue saves return whether a record was written; artwork separates catalog updates from image commits; audio streams responses to disk and maintains its shared catalog internally. Audio access remains scoped to the configured account. Persisted/untrusted reads are validated; already-typed writes are not reparsed. Engines own publication, local write ordering, and browser object URLs. Storage owns file I/O, Web Locks, atomic replacement, and persisted-record validation.

- The service worker precaches only the production app shell, manifest, and install icons. The style guide is not available offline.
- Subsonic API requests, artwork, and audio streams are not runtime-cached by the service worker. Storage persists metadata, artwork, and downloads; engines decide when to acquire and publish them.
- Metadata, queue state, cover catalogs, and the downloads catalog share `src/json-store.ts`: validated JSON reads, serialized read–modify–write operations, named Web Locks, atomic replacement, and optional stale-write cancellation before commit. Storage owns persisted-record validation and atomic conflict comparisons; engines interpret conflicts and decide subsequent workflow. Corrupt files are preserved by default; metadata and queue explicitly retain their repair-on-write policies. Storage owns binary audio/image files; engines own browser object URLs.
- Authentication lives under `navidrome-auth` in localStorage. `navidrome-account` contains only the last selected host and username, allowing startup to restore OPFS data without credentials. Disconnect preserves this identity and persists `navidrome-offline-mode=true`; only a successful explicit connection unlocks online browsing. Existing saved authentication is migrated to a non-secret account record at startup.
- Metadata is a complete OPFS snapshot at `metadata/<account-hash>.json`, with normalized artist, album, and track arrays. Tracks reference artists and albums by ID; runtime maps provide lookups and sorted relationships. The snapshot restores at startup before network connection/revalidation, stays visible during refresh, and is replaced only after a complete validated save. No credentials are stored in it.
- Artwork has an account-scoped OPFS catalog at `images/<account-hash>.json`: precomputed artist/album/track references plus completed image records, file sizes, MIME types, and HTTP validators. Startup restores the catalog without scanning image files; image bytes are loaded lazily and missing or incomplete files are repaired on access. Metadata replacements explicitly rebuild references while retaining downloaded images. Catalog writes use Web Locks where available, and playback requests cached artwork only.
- Previous image files and per-image JSON sidecars are left untouched, not migrated. Artwork is downloaded into the new catalog on demand when online; old files alone no longer provide offline artwork.
- The queue persists to `queue/<account-hash>.json`: local ordered IDs, occurrence index, position, and timestamp. Legacy `server` snapshots are accepted and discarded on read, and omitted on the next save. Restoration needs no credentials or autoplay, even when metadata is unavailable. Queue commands are debounced by 300 ms; playback position is checkpointed locally every five seconds, and pause/hide/flush saves the latest state. Newer disk records produce storage errors rather than successful acknowledgements; blocked writes are not uploaded. Abrupt browser termination may lose changes since the last completed write.
- Playback resolves queue IDs through metadata on demand. Missing metadata and Offline Library restrictions hide unavailable entries without deleting IDs or resetting the saved selection/position. Row actions and next/previous navigation use original queue indexes, preserving duplicate occurrences and skipping unavailable tracks. Only explicit queue edits change membership; incomplete metadata is never uploaded as a shortened queue. Downloads retain independent track descriptions.
- The old IndexedDB metadata cache is no longer read or migrated. Connect online once to populate the new snapshot. Downloaded audio, artwork, and saved authentication are not removed.
- **Settings → Downloads** lists active downloads, queued tracks, and completed files newest-first. Downloads run with up to three concurrent transfers. Playback does not wait for downloads when seeking or resuming.
- Audio lives in OPFS under `tracks/`. The adjacent `downloads.json` is a validated list of completed file references, track metadata, account scope, format, size, and completion date; it contains neither credentials nor active/queued jobs. Storage loads it into a private index and serializes catalog writes; TrackEngine publishes completed records into Memory. Per-audio-file Web Locks cover the cache recheck, binary write, and catalog commit: a later writer reuses a completed download and cancels its unused response. Failed writes preserve nonempty files, including recoverable orphans. Cross-tab serialization requires Web Locks; without them, failed writes also retain empty placeholders to avoid racing another writer's close.
- Existing hashed audio files are adopted into the catalog when matched against library metadata, retaining their file modification dates. Files that cannot be matched remain untouched. The saved catalog can be listed without reloading the music library; missing file references are removed when the catalog opens.
- Cached tracks and seeks within the current audio buffer use local seeking. Original-file streams also use native seeking within the browser's advertised `seekable` ranges, allowing HTTP byte-range requests without restarting transcoding. If setting the native seek position throws, playback falls back to an offset stream. Transcoded streams do not trust unbuffered seekable ranges. Uncached resumes and other unbuffered seeks request an MP3 stream with Subsonic `timeOffset` rather than downloading the entire track first. The player translates stream-relative time into full-track position and uses library metadata for full duration. This depends on the server honoring `timeOffset`; verify against Navidrome when testing. Playback never starts a separate background audio download; offline downloads are explicit user actions. Previously downloaded tracks remain available for local playback. Offset streams are never saved as complete downloads.
- First visit online so installation and shell caching can complete. Download music in the app before testing Offline Library mode.
- Test Settings refresh/disconnect, reload after disconnect, failed reconnect while forced offline, and reconnect to another account with overlapping track IDs. Saved credentials must be gone after disconnect; metadata, artwork, audio, and queue must remain usable offline. Check cancellation during both server requests and connection persistence. App settings DOM tests cover read-only actions, disabled refresh, forced-offline connection, credential input clearing, and late completions.
- A new version adds a dot to the settings button and a persistent **Update now** action in Settings. There is no update popup or dismiss action. The updater remains mounted across route changes, so navigating away does not clear availability. Nothing reloads automatically during playback; choosing Update now explicitly reloads the app and interrupts playback. Setup errors and retryable update failures are also shown in Settings.
- Updates are checked when the app becomes visible and hourly while visible and online.

## Testing app updates

To test updates, leave the installed app open, change the app, run `pnpm build` again, then return to the app to trigger a check. Chrome DevTools' Application panel can inspect the manifest, service worker, and caches. Clear site data or unregister the worker when testing a completely fresh installation (clearing site data also deletes saved app data).
