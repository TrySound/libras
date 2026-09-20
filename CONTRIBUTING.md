# Contributing to Libras

Libras is a client-only Svelte + Vite app using the Subsonic API. See the [README](README.md) for features and hosted-app setup.

## Local development

Use Node.js 22 and the pnpm version in `package.json`.

```sh
pnpm install
pnpm dev
```

Your music server must allow the app's origin through CORS. Use HTTPS outside local development.

Before submitting changes:

```sh
pnpm check
pnpm test
pnpm build
```

`pnpm format` formats the project; the pre-commit hook formats staged HTML, CSS, Svelte, and TypeScript files. Production code lives in `src/`, tests and test-only helpers in `tests/`.

## Architecture at a glance

`src/app.svelte` wires the engines together. Route components (`src/_*.svelte`) read reactive state and invoke domain commands.

| Module                        | Owns                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `Session`                     | Account selection, credentials, connections, startup, and refresh coordination             |
| `Network`                     | Subsonic requests, response normalization, authenticated URLs, and connection cancellation |
| `Cache`                       | Account-scoped library, queue, images, downloads, and OPFS persistence                     |
| `MetadataEngine`              | Library fetching and refresh cancellation                                                  |
| `QueueEngine`                 | Queue edits, server synchronization, and playback protection                               |
| `PlaybackController`          | Queue navigation and playback orchestration                                                |
| `Player`                      | Audio transport, seeking, keyboard shortcuts, and Media Session                            |
| `CoverEngine` / `TrackEngine` | On-demand resources, download scheduling, and object URL lifetimes                         |

Keep these boundaries in mind:

- Read Cache collections directly; change them through explicit methods. Session owns account details; Cache accepts an opaque `key` from `getAccountKey(account)` and hashes it internally for storage. Engines compare that key with the connection's account key. An undefined key creates an empty, non-persisting fallback; a defined key does not imply storage loaded successfully. Keep credentials, network clients, and browser resources outside Cache.
- Memory updates immediately; disk checkpoints happen asynchronously. Failed writes retain local state and report errors. Do not treat visible state as proof of persistence.
- Startup and manual refresh pull server state. Reconnecting does not automatically refresh or upload an offline queue. Refresh must not replace a playing or paused queue.
- Disconnect retains local data for offline use. Session reconnects prepare and checkpoint the candidate, retire a different account's resource work and drain its writes, then synchronously commit credentials, selection, and engine connections. Same-account reconnects reuse the live cache to preserve edits. Startup selects local data before hydration but activates the queue only after loading finishes. Network owns the shared connection abort signal; late results must not leak into the new account.
- Preserve queue IDs and occurrence indexes, including duplicates and unavailable tracks. Filtering the UI must not rewrite the saved queue.
- Release owned browser resources explicitly. The service worker caches the app shell, not API responses or music; offline audio downloads are explicit user actions.

For implementation details, consult the owning module and its tests rather than adding a second state store or synchronization layer.

### Application entry points

`Network` accepts an optional `SubsonicClientFactory`; the default remains the authenticated HTTP client. Alternate clients implement the public `SubsonicApi` surface while Network retains cancellation and connection ownership. App requires `network`, `auth`, and `updaterComponent` from its entry point; these dependencies are fixed for a mounted application's lifetime. Its preferences, settings UI, header and title remain inline. The normal entry point supplies `WebappUpdater`; entries explicitly passing `undefined` do not import or register PWA support.

### Server identity

Explicit login validation uses its existing authenticated `ping()` request to verify OpenSubsonic identity: `version` is the Subsonic API version, `type` is the server name, `serverVersion` is the server release, and `openSubsonic` must be `true`. Unknown server names are accepted. Failed requests retain their server error even without identity fields. Identity is returned by the protocol client but is not persisted; no discovery requests or authentication changes are introduced.

### Genre metadata

Library synchronization reads OpenSubsonic structured `genres` on albums and tracks. Names and their order are preserved as supplied, including duplicates; delimiters such as `|` remain part of a name. Missing genres become empty arrays, without falling back to legacy `genre` strings. ArtistID3 has no genre fields, so artist records do not store genres. The artist page derives its genres from the artist's albums.

### Artist credits

Library synchronization reads OpenSubsonic `artists` and `displayArtist` on albums and tracks, without falling back to legacy `artist` or `artistId` response fields. Artist records and structured credits require IDs and names. Albums and tracks store ordered `artistIds` arrays. Every referenced artist, including track-only contributors, is retained once in the artist collection. Albums are indexed under each credited album artist; primary navigation links still use the first credit.

Albums and tracks store `displayArtist`: the supplied display credit, otherwise the resolved artist names joined with commas. Missing track credits inherit all album artists; display-only credits get stable local IDs, and albums without credits use an unknown-artist placeholder. Embedded credit names and artwork are not duplicated in stored album/track relationships. This replaces the stored `artistId` and track `artistName` fields without a cache compatibility layer; old cached libraries need to be fetched again.

## Testing browser behavior

For playback or synchronization changes, check refresh, disconnect/reload, offline playback, failed reconnects, and switching accounts with overlapping track IDs. Test seeking, duplicate queue entries, and cancellation during in-flight work.

Service workers are disabled during development. To test installation or offline behavior:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://localhost:4173` in Chrome and install the app. Visit online and download music before testing offline playback. For a remote development machine, forward the port from the phone:

```sh
ssh -N -L 4173:127.0.0.1:4173 user@your-server
```

The music server must be reachable from the phone. Changing the app's host or port changes its origin and stored data. Vite preview is for testing, not production hosting.

To test updates, leave the installed app open, rebuild, and return to it. **Update now** should reload only after approval and preserve the route, including after a hard refresh. Inspect service workers in Chrome DevTools → Application. Clearing site data also deletes saved app data.

## Deployment and assets

- [CI](.github/workflows/ci.yml) runs checks, tests, and a production build for pull requests and pushes to `main`.
- [GitHub Pages](.github/workflows/pages.yml) deploys `main` independently of CI. Set Settings → Pages → Source to **GitHub Actions**. Preview its base path with `BASE_PATH=/libras/ pnpm build`, then `pnpm preview` and open `/libras/`.
- For another deployment, update the canonical and social-preview URLs in `index.html`.
- Social artwork: edit `public/og.svg`, then regenerate `public/og.png` (1200×630) with resvg and DejaVu Sans.
- App icons: keep `public/icon.svg`, the header logo, and raster icons in sync. Generate PNGs with resvg and the ICO with png-to-ico; preserve maskable safe areas. Attribution is in `public/icons/phosphor-license.txt`.

## UI conventions

- Store all UI icons in `src/icon.svg` as `<symbol id="name">` elements. Render them with the typed `Icon` component from `src/icon.svelte`, rather than embedding icon geometry in components. Keep its `IconName` union in sync with the sprite. The sprite is emitted as a separate asset, not embedded in JavaScript. Use `currentColor` for themeable fills and strokes, and give icon-only controls accessible labels.
- Prefer native invoker commands for popovers and dialogs: use `commandfor="element-id"` with `command="toggle-popover"`, `"show-popover"`, `"hide-popover"`, `"show-modal"`, or `"close"`. Prefer these over `popovertarget`/`popovertargetaction` and JavaScript click handlers that only open or close an overlay. Reserve imperative APIs for behavior that cannot be expressed declaratively, such as swipe-to-dismiss.

- Popover invokers establish an implicit anchor automatically. Do not add `anchor-name` or `position-anchor` just to associate a popover with its invoker; use that implicit anchor for positioning (for example, `top: anchor(bottom)`).
