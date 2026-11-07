# Contributing to Libras

Libras is a client-only Svelte + Vite app using the Subsonic API. See the [README](README.md) for features and hosted-app setup, and [website/README.md](website/README.md) for the landing page, Deezer demo, and combined deployment.

## Local development

Use Node.js 26 and the pnpm version declared in `package.json` (also used by CI).

```sh
pnpm install
pnpm dev
# Website and standalone demo at /demo/:
pnpm --filter @libras/website dev
```

Your music server must allow the app's origin through CORS. Server connections require HTTPS; token authentication permits HTTP loopback (`localhost`, `127.0.0.1`, `[::1]`) only in development builds. Direct-password authentication always requires HTTPS, including restored sessions.

Before submitting changes:

```sh
pnpm check
pnpm test
pnpm build
pnpm --filter @libras/website build
```

The workspace contains the root app (`src/`, `tests/`) and `@libras/website` (`website/`). Each builds to its own `dist/`. Root check/test commands cover both packages. `pnpm format` formats the project; the pre-commit hook formats staged HTML, CSS, Svelte, and TypeScript files.

## Architecture and ownership

`src/app.svelte` wires the engines together. Route components (`src/_*.svelte`) read reactive state and invoke domain commands.

| Module                       | Owns                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `Session`                    | Account/cache activation, startup, cancellation, disconnect, and refresh coordination              |
| `AuthStore` / `authenticate` | Credential persistence / token derivation and automatic HTTPS password fallback                  |
| `Network` / `SubsonicClient` | Connection cancellation, normalized domain access / Subsonic protocol requests                   |
| `Cache`                      | Account-scoped library, queue, images, downloads, playlists, and OPFS persistence                |
| `Playback`                   | Queue commands, server synchronization, and playback orchestration                               |
| `AudioPlayer`                | Audio transport, seeking, keyboard shortcuts, and Media Session                                  |
| `Covers` / `TrackEngine`     | Resource acquisition, download scheduling, and browser URL lifetimes                             |
| `Playlists`                  | Server-confirmed playlist operations and conflict detection; no offline outbox                   |
| `Router`                     | Query routes, native fragment anchors, active navigation metadata, and optional view transitions |

Routes use the bare query, for example `/webapp/?/library/artist/123#section`. Encode each dynamic path segment with `encodeURIComponent`; fragments remain native in-page anchors. The service worker serves one cached app shell for root/index navigation requests, including their route queries; assets and API requests are excluded.

### Persistence and account safety

- Read Cache collections directly; change them through explicit methods. Session owns account details; Cache accepts an opaque account key and hashes it for storage. An undefined key creates an empty, non-persisting fallback. A defined key does not mean hydration succeeded.
- Memory updates immediately; disk checkpoints happen asynchronously. Failed writes retain local state and report errors. Do not treat visible state as proof of persistence.
- Credentials use localStorage only, until disconnect. Token login stores username/token/salt; verified direct-password fallback stores the actual password. localStorage is not encrypted and is readable by same-origin scripts. Never log credentials or credential-bearing URLs. Legacy token records migrate without changing account keys; migration writeback is best-effort.
- Disconnect retains local data for offline use. Same-account reconnects reuse the live cache to preserve edits. Account changes drain old writes and retire resources before committing the new workspace. Late results must not leak into a different account.
- Startup and manual refresh pull server state. Reconnecting must not upload an offline queue automatically, and refresh must not replace a playing or paused queue.
- Preserve queue IDs and occurrence indexes, including duplicates and unavailable tracks. Filtering the UI must not rewrite the saved queue.
- Release browser resources explicitly. The service worker caches the app shell, not API responses or music; offline audio downloads are explicit user actions.

Consult the owning module and tests for implementation details rather than adding a second state store or synchronization layer.

### Entry points and metadata

The app and `/demo/` are separate document-scrolling pages using the same App component; there is no embedded rendering mode. Entry points supply fixed `network`, `auth`, and `updaterComponent` dependencies. The normal entry supplies `WebappUpdater`; the demo passes `undefined` and does not register PWA support. `Network` accepts a `SubsonicClientFactory` so alternate clients can implement `SubsonicApi` without changing connection ownership.

Login uses the existing username/password form and tries a locally derived salted token first. Authenticated `ping()` requires OpenSubsonic support; unknown server names are accepted. Only structured Subsonic errors 41/42 automatically retry the same username/password over HTTPS, including localhost. Persist credentials only after successful verification and workspace commit. Never downgrade for code 40, network/timeouts, HTTP, generic, or malformed responses. Protocol identity is not persisted. The client preserves protocol codes while sanitizing request/protocol errors so URLs, secrets, and secret-bearing causes are not exposed. One credential serializer keeps token `u/t/s` exclusive from password `u/p` for requests and media URLs; Subsonic hex encoding for a literal `enc:` password prefix is not encryption.

Library normalization uses structured `artists`, `displayArtist`, and `genres`, not legacy artist/genre fields. Preserve supplied order, punctuation, and duplicate genre names. Missing track credits inherit album credits; display-only artists receive stable local IDs. Keep every referenced artist, including track-only contributors, and index albums under all credited contributors without duplicating records. Stored relationships use IDs; display credits and artwork inheritance are resolved during normalization. Old incompatible libraries need a network refresh rather than a new compatibility layer.

## UI conventions

`styleguide.html` is the visual reference: run `pnpm dev` and open `/styleguide.html`. It consumes production styles; keep visual recipes there and in CSS, not duplicated in this document.

- `src/edgerunner.css` owns theme foundations, shared components, and app layout. Tokens live on `:root`; shared typography, utilities, cards, and buttons opt in through `.app-root`, `.design-reference`, or `.website`. App-only presentation stays out of the landing page. `website/website.css` owns marketing composition and decoration.
- Use semantic color/type roles and spacing/shape primitives. Containers own gaps and padding. Avoid global element resets and additional token aliases or configuration layers without a concrete consumer.
- `src/ui/` contains shared presentation. Artwork delegates acquisition and object-URL ownership to Covers. Atmosphere uses CSS scroll timelines with static fallbacks for unsupported browsers and reduced motion; don't add scroll handlers for decoration.
- The app scrolls the document with native page overscroll. Container queries adapt navigation and split layouts without remounting playback. Now Playing is a fullscreen native dialog with its own scrolling. Modal dialogs/backdrops suppress scroll chaining and boundary bounce without changing document overflow.
- Preserve offline filtering, ordered playback, and action scope. Library batches remain lazy. Downloads show real jobs and saved records, not invented progress. Queue rows use original occurrence indexes.
- Keep native validation, keyboard focus, actual error messages, and guarded busy actions. Never expose credentials. A completed connection must not redirect after the user leaves Settings. Update state is shared between sidebar and drawer.
- Prefer native `commandfor`/`command` invokers for dialogs and popovers. Use imperative APIs only for behavior that cannot be expressed declaratively. Popovers already have implicit invoker anchors. Preserve long-press and swipe dismissal; don't dismiss overlays on resize.
- Store UI icons in `src/sprite.svg` and render through typed `Icon`; keep its name union synchronized. Use `currentColor` and accessible labels for icon-only controls. The build injects the sprite into HTML, not JavaScript.
- Self-hosted fonts and their license live in `src/fonts/`; preserve optional loading and system fallbacks. Keep font preloads aligned with the faces each entry point uses.

## Testing

Use unit/component tests for state and behavior. Static HTML tests cover destinations, metadata, content, and script-free delivery; don't parse CSS with regexes or enforce exact class counts or scope spelling. Browser tests cover computed styles, overflow, focus, native overlays, and responsive behavior.

### Optional browser suites

Install Playwright and Chromium externally. With an app dev/preview server running:

```sh
# NODE_PATH is only needed when Playwright is outside Node's normal module path.
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5173 \
  node --test tests/browser/navigation.test.cjs
```

Select suites for the behavior being changed:

| Suite in `tests/browser/`                 | Coverage                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `edgerunner.test.cjs`                     | Shared styles, fonts, native controls, overlays, and reduced motion                                                                     |
| `navigation.test.cjs`                     | Document scrolling, shell, playback, query routes, anchors, and optional offline navigation                                             |
| `startup.test.cjs`                        | Initial Settings route, reloads, and subsequent animated navigation                                                                     |
| `library.test.cjs`, `search.test.cjs`     | Browsing, actions, responsive layouts, and native dismissal                                                                             |
| `downloads.test.cjs`, `settings.test.cjs` | Actual app/OPFS behavior with intercepted Subsonic requests                                                                             |
| `atmosphere.test.cjs`                     | Document/dialog scroll timelines; self-contained, no server required                                                                    |
| `website-cascade.test.cjs`                | Script-free landing layout, keyboard/FAQ behavior, and standalone demo journeys                                                         |
| `design-improvements.test.cjs`            | Compact details, full-height player, queue anchors, confirmation, gradients, popover timing, titles, and demo guidance (website server) |

Run the website suite against the website server, not the app:

```sh
pnpm --filter @libras/website build
pnpm --filter @libras/website preview --host 127.0.0.1 --port 5180 --strictPort
# In another terminal:
NODE_PATH=/path/to/external/node_modules PREVIEW_URL=http://127.0.0.1:5180 \
  node --test tests/browser/website-cascade.test.cjs
```

Set `TEST_OFFLINE=1` when running `navigation.test.cjs` against a production preview to also check service-worker app-shell navigation with query routes.

For subpath deployments, include the base path in `PREVIEW_URL`. Browser suites are not part of `pnpm test`: DOM emulation cannot validate CSS layout or native overlays. Review both the running app/demo and the styleguide, including long labels, enlarged text, and reduced motion.

For playback/synchronization changes, check refresh, disconnect/reload, offline playback, failed reconnects, duplicate queue entries, and account switches with overlapping track IDs. Include cancellation during in-flight work.

### Installation, offline use, and updates

Service workers are disabled during development. Use a production preview:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://localhost:4173` in Chrome, visit online, and download music before testing offline playback. For a remote machine, forward the port with `ssh -N -L 4173:127.0.0.1:4173 user@your-server`; the music server must also be reachable from the phone. Changing origin changes stored data. Clearing site data deletes it.

To test updates, leave the installed app open, rebuild, and return to it. Update now should reload only after approval and preserve the route. Inspect service workers in browser DevTools. Vite preview is for testing, not production hosting.

## Deployment and assets

- [CI](.github/workflows/ci.yml) checks, tests, and builds both packages. [Pages](.github/workflows/pages.yml) deploys `main` independently of CI; select GitHub Actions as the Pages source. See [website/README.md](website/README.md#pages-deployment) for the combined artifact and verification command.
- `BASE_PATH` configures the app build path. For another deployment, update canonical/social URLs in both HTML entry points and the website sitemap/robots files.
- Social artwork: edit `public/og.svg`, then regenerate `public/og.png` with resvg and DejaVu Sans. Keep app SVG/raster icons synchronized and preserve maskable safe areas. Icon attribution is in `public/icons/phosphor-license.txt`.
