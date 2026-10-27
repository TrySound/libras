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

`pnpm format` formats the project; the pre-commit hook formats staged HTML, CSS, Svelte, and TypeScript files. The pnpm workspace contains the root `libras` application (`src/`, `tests/`) and `@libras/website` (`website/`), which imports the shared app. Each package builds to its own `dist/`. Use `pnpm --filter @libras/website dev` or `build` for the static demo. Root `pnpm check` checks both packages, and root `pnpm test` runs both test suites.

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
| `AudioPlayer`                 | Audio transport, seeking, keyboard shortcuts, and Media Session                            |
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

### Gradual Edgerunner redesign

[Migration tracker #55](https://github.com/TrySound/libras/issues/55) owns the sequence.
`styleguide.html` is the existing, evolving visual reference; run `pnpm dev` and open
`/styleguide.html`. It uses the same styles as production, not a separate component library.

- `src/app.css` retains legacy styles behind a temporary scope boundary and imports
  `src/edgerunner.css`. Opt a migrated route into the new design with `.ui-edgerunner`.
  Appearance rules opt in there; legacy selectors stop at that boundary.
  Do not mix legacy and new component markup within a migrated subtree.
  `website/website.css` uses the same bounded scope so equally specific website
  extensions still override shared rules by source order, without leaking into migrated islands.
- Give any dialog/popover mounted outside that subtree its own `.ui-edgerunner` class.
  It must inherit the new foundations even while closed; preserve native hidden behavior.
- Edgerunner ports the Original visual system from the `libras-new` design study:
  published Figma Maroon/Gold primitives → semantic color and complete typography roles.
  Consume roles for colors/type, primitives for ordinary spacing/shape, and keep component
  configuration local. Containers own gaps/padding. Avoid global element resets.
- Downloads (`src/_downloads.svelte`) is the first migrated route. It reads real
  jobs and saved records, retains ordering and format-specific identities, and adds no fake
  progress or per-file failure records. Transfer/storage notices do not discard saved rows.
- Settings (`src/_settings.svelte`) uses shared cards and an app-container-based 3:2 split;
  preserve the inline-size container so the embedded demo adapts independently of the browser.
  Session owns authentication, disconnect, offline preferences, and automatic/manual sync.
  Explicit refresh feedback and scan counters share the full sync operation's lifetime.
  Keep native field validation, bare-hostname support, and actual server errors; never expose
  authentication secrets. Busy actions stay mounted with guarded `aria-disabled` states, and
  completed connections must not redirect after leaving or hiding Settings. PWA updates remain
  in a shared shell popover. Presentation examples belong in `styleguide.html`; behavior contracts
  are covered by `tests/app-settings.test.ts`.
- Library (`src/_library.svelte`) uses shared collection tiles and an app-container-aware
  auto-fit grid. Preserve artist ordering, 48-item lazy batches, offline filtering, and real
  collection actions. Explicit options open a mobile modal or desktop popover; long-press
  retains the shared modal with Escape/close-button/swipe dismissal (light-dismiss would
  consume the long-press release). Overlay dismissal stays native rather than resize-driven.
- Edgerunner navigation, player controls, page gutters, tile sizing, and shared
  `.only-mobile` / `.only-desktop` utilities switch at app widths >50rem (800px at the
  default root size). Split layouts instead query the nearest size container: stacked
  through 50rem, equal columns above 50rem, and 2:3 above 64rem (3:2 for Settings).
  Detail panels become sticky with the first split. The page is an inline-size container,
  so its content width excludes the sidebar and gutters; other hosts can supply their own container.
- Artist and album details keep their panel markup and contextual actions inline in each route.
  They follow the prototype's split layout and CSS-only cover height budget, adapting to
  the available page content rather than the host viewport. Artist albums use unnumbered media rows;
  album tracks retain ordered playback, credits, durations, download states, and current-track
  selection. Keep offline filtering, long-press, and independent row options intact.
  Each detail route renders its own decorative atmosphere from the same Covers source as
  the foreground image. It fills the positioned app shell behind content/chrome, using
  12% opacity and the prototype's radial mask, with top-aligned artwork and a subtle
  4px blur on the atmosphere only; missing artwork stays hidden.
- Edgerunner components live in `src/ui/`; legacy components remain in place until their
  consumers migrate. The new artwork presentation delegates loading/URL ownership to Covers,
  and resolves optional IDs from the current library without changing saved download metadata.
  The shared Icon accepts explicit numeric dimensions and semantic colors; legacy sizes/defaults
  are unchanged. Readonly download rows have no hover/press feedback or Tab stops.
- Introduce compound components with their first consumer, not all at once. Preserve real
  application behavior, long-press, and swipe-to-dismiss; do not port the prototype runtime.
  Additional Highrider themes/selection are separate work in #54.
- `src/edgerunner-fonts.css` loads self-hosted Rajdhani v17 (500/600/700), sourced from
  Google Fonts, with Latin-only subsets and `font-display: optional`. Other characters
  use system-font fallbacks rather than additional bundled subsets. A short browser-managed
  loading window allows a fast font load; otherwise the page keeps its system fallback without
  a late swap. The styleguide preloads the Latin 500 heading face; add critical-font preloads
  to production entry points only when they start using the new typography.
  Fonts and the SIL OFL license
  live in `src/fonts/`; unsupported glyphs and unavailable fonts use system fallbacks.
  Relative asset URLs support both the app and embedded website builds.

The optional real-browser foundation suite checks scoped coexistence, native controls,
focus, overlays, responsive sizing, local fonts, artwork, and reduced motion. With a dev
or preview server running and Playwright/Chromium installed externally:

```sh
# NODE_PATH is only needed when Playwright is not on Node's normal module path.
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5173 \
  node --test tests/browser/edgerunner.test.cjs
```

The website cascade suite uses the website server (`pnpm --filter @libras/website dev`)
with its own URL. It checks desktop overrides, mobile demo launch/dismissal, mounted-node
preservation on resize, and isolation from Edgerunner islands:

```sh
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5180 \
  node --test tests/browser/website-cascade.test.cjs
```

The Downloads suite runs against the app server, intercepting only the Subsonic transport.
It exercises actual connection, long-press Download actions, queued/active transfers,
completion/failure, responsive artwork and text, OPFS checkpoints, and disconnected reload:

```sh
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5173 \
  node --test tests/browser/downloads.test.cjs
```

The Library browser check exercises real cached artists, lazy batches, wrapping/missing artwork,
responsive options, native overlay dismissal/focus, and the Library → Artist → Album journey,
including contextual track/collection actions:

```sh
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5173 \
  node --test tests/browser/library.test.cjs
```

Settings state/rendering, error handling, refresh phases, and navigation races are covered by
`tests/app-settings.test.ts` in the normal CI suite. The optional browser suite uses the real
app/OPFS with only Subsonic transport intercepted. It focuses on browser-only behavior: native
validation without layout shifts, keyboard/focus, responsive/enlarged-text layouts, and offline
preferences and cached metadata surviving reload:

```sh
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5173 \
  node --test tests/browser/settings.test.cjs
```

The navigation shell's native drawer, active deep links, CSS responsive visibility, document
scrolling, and enlarged-text layout have a separate browser check:

```sh
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5173 \
  node --test tests/browser/navigation.test.cjs
```

`src/app.svelte` owns shell markup, Session, and AudioPlayer; `src/edgerunner.css` owns shared
placement and page gutters. Container queries switch navigation without remounting playback.
Standalone apps scroll the document; embedded apps retain host-owned sizing and local scrolling.
Router exports reactive `route` metadata (`url`, resolved `pattern`) and `isCurrentPage(path)`
for active navigation. Drawer links close it; route changes and resizing do not.

For a subpath deployment, include the base path in `PREVIEW_URL`. These optional suites are
not part of `pnpm test`; DOM emulation does not validate CSS scope, layout, or native overlays.
Review the styleguide visually as well, including long labels and enlarged text. During
coexistence, check a migrated island inside the legacy shell, not only the all-new reference.

- Store all UI icons in `src/sprite.svg` as `<symbol id="name">` elements. Render them with the typed `Icon` component from `src/icon.svelte`, rather than embedding icon geometry in components. Keep its `IconName` union in sync with the sprite. The sprite is emitted as a separate asset, not embedded in JavaScript. Use `currentColor` for themeable fills and strokes, and give icon-only controls accessible labels.
- Prefer native invoker commands for popovers and dialogs: use `commandfor="element-id"` with `command="toggle-popover"`, `"show-popover"`, `"hide-popover"`, `"show-modal"`, or `"close"`. Prefer these over `popovertarget`/`popovertargetaction` and JavaScript click handlers that only open or close an overlay. Reserve imperative APIs for behavior that cannot be expressed declaratively, such as swipe-to-dismiss.

- Popover invokers establish an implicit anchor automatically. Do not add `anchor-name` or `position-anchor` just to associate a popover with its invoker; use that implicit anchor for positioning (for example, `top: anchor(bottom)`).
