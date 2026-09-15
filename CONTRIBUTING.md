# Contributing to Libras

Libras is a client-only Svelte + Vite app targeting the OpenSubsonic API. See the [README](README.md) for features and hosted-app setup.

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

| Module                        | Owns                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `Session`                     | Account selection, credentials, connections, startup, and refresh coordination                 |
| `Network`                     | OpenSubsonic requests, response normalization, authenticated URLs, and connection cancellation |
| `Cache`                       | Account-scoped library, queue, images, downloads, and OPFS persistence                         |
| `MetadataEngine`              | Library fetching and refresh cancellation                                                      |
| `QueueEngine`                 | Queue edits, server synchronization, and playback protection                                   |
| `PlaybackController`          | Queue navigation and playback orchestration                                                    |
| `Player`                      | Audio transport, seeking, keyboard shortcuts, and Media Session                                |
| `CoverEngine` / `TrackEngine` | On-demand resources, download scheduling, and object URL lifetimes                             |

Keep these boundaries in mind:

- Read Cache collections directly; change them through explicit methods. Keep credentials, network clients, and browser resources outside Cache.
- Memory updates immediately; disk checkpoints happen asynchronously. Failed writes retain local state and report errors. Do not treat visible state as proof of persistence.
- Startup and manual refresh pull server state. Reconnecting does not automatically refresh or upload an offline queue. Refresh must not replace a playing or paused queue.
- Disconnect retains local data for offline use. Session reconnects prepare and checkpoint the candidate, retire a different account's resource work and drain its writes, then synchronously commit credentials, selection, and engine connections. Same-account reconnects reuse the live cache to preserve edits. Startup selects local data before hydration but activates the queue only after loading finishes. Network owns the shared connection abort signal; late results must not leak into the new account.
- Preserve queue IDs and occurrence indexes, including duplicates and unavailable tracks. Filtering the UI must not rewrite the saved queue.
- Release owned browser resources explicitly. The service worker caches the app shell, not API responses or music; offline audio downloads are explicit user actions.

For implementation details, consult the owning module and its tests rather than adding a second state store or synchronization layer.

### OpenSubsonic migration

`src/opensubsonic-client.ts` owns the protocol schemas and exports only OpenSubsonic-named types; there is no parallel legacy client or type alias layer. The wire protocol still uses `/rest`, the `subsonic-response` envelope, and the Subsonic API version parameter (`1.16.1`).

The client provides explicit `ping()` server identification and `getOpenSubsonicExtensions()` discovery. Unknown extension names and advertised versions are preserved. These methods do not run automatically yet; connection behavior, saved credentials, queue synchronization, and streaming remain unchanged.

Metadata schemas consume structured `genres`, `artists`, `albumArtists`, and display artist fields rather than legacy `genre`, `artist`, or `artistId`. ArtistID3 records require IDs and do not expose genres. Genre names are trimmed and deduplicated, not split on delimiters. Optional missing fields remain valid, but legacy-only metadata is intentionally not recovered: genres become empty and absent artist credits use display names or an unknown-artist placeholder.

The persisted browsing model still has one artist ID per album/track. Normalization selects the first credited artist for identity, retaining a track's full display credit (or joining credited names). Additional artist relationships are not persisted yet. Existing cached libraries remain readable; a refresh uses the new normalization. Full multi-artist storage/browsing, discovery during connection preparation, index-based queues, transcoding capability gating, and API-key authentication are subsequent steps.

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

- Store all UI icons in the SVG sprite in `index.html` as `<symbol id="icon-name">` elements. Render them with `<use href="#icon-name">` (or the `icon()` snippet in `src/app.svelte`), rather than embedding icon geometry in components. Use `currentColor` for themeable fills and strokes, and give icon-only controls accessible labels.
- Prefer native invoker commands for popovers and dialogs: use `commandfor="element-id"` with `command="toggle-popover"`, `"show-popover"`, `"hide-popover"`, `"show-modal"`, or `"close"`. Prefer these over `popovertarget`/`popovertargetaction` and JavaScript click handlers that only open or close an overlay. Reserve imperative APIs for behavior that cannot be expressed declaratively, such as swipe-to-dismiss.

- Popover invokers establish an implicit anchor automatically. Do not add `anchor-name` or `position-anchor` just to associate a popover with its invoker; use that implicit anchor for positioning (for example, `top: anchor(bottom)`).
