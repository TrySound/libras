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

Your music server must allow the app's origin through CORS and support OpenSubsonic's empty-query `search3` for library synchronization. Production connections require HTTPS; HTTP loopback is development-only, and direct password authentication always requires HTTPS.

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

| Module                       | Owns                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `AuthWorkflow`               | Discovery-driven login, credential preparation, verified identity, confirmation, and attempt cancellation |
| `Session`                    | Authenticated account/cache activation, offline recovery, startup, disconnect, and refresh coordination   |
| `Network` / `SubsonicClient` | Candidate/live connection cancellation and domain access / wire encoding, discovery, and protocol errors  |
| `Cache`                      | Account-scoped library, queue, images, downloads, playlists, and OPFS persistence                         |
| `Playback`                   | Queue commands, server synchronization, and playback orchestration                                        |
| `AudioPlayer`                | Audio transport, seeking, keyboard shortcuts, and Media Session                                           |
| `Covers` / `TrackEngine`     | Resource acquisition, download scheduling, and browser URL lifetimes                                      |
| `Playlists`                  | Server-confirmed playlist operations and conflict detection; no offline outbox                            |
| `Router`                     | Query routes, native fragment anchors, active navigation metadata, and optional view transitions          |

Routes use the bare query, for example `/webapp/?/library/artist/123#section`. Encode each dynamic path segment with `encodeURIComponent`; fragments remain native in-page anchors. The service worker serves one cached app shell for root/index navigation requests, including their route queries; assets and API requests are excluded.

### Persistence and account safety

- Read Cache collections directly; change them through explicit methods. Session owns account details; Cache accepts an opaque account key and hashes it for storage. An undefined key creates an empty, non-persisting fallback. A defined key does not mean hydration succeeded.
- Memory updates immediately; disk checkpoints happen asynchronously. Failed writes retain local state and report errors. Do not treat visible state as proof of persistence.
- Disconnect retains local data for offline use. Same-account reconnects reuse the live cache to preserve edits. Account changes drain old writes and retire resources before committing the new workspace. Late results must not leak into a different account.
- Startup and manual refresh pull server state. Reconnecting must not upload an offline queue automatically, and refresh must not replace a playing or paused queue.
- Preserve queue IDs and occurrence indexes, including duplicates and unavailable tracks. Filtering the UI must not rewrite the saved queue.
- Release browser resources explicitly. The service worker caches the app shell, not API responses or music; offline audio downloads are explicit user actions.

Consult the owning module and tests for implementation details rather than adding a second state store or synchronization layer.

### Entry points and metadata

The app and `/demo/` are separate document-scrolling pages using the same App component; there is no embedded rendering mode. Entry points supply fixed `network`, `auth`, and `updaterComponent` dependencies. The normal entry supplies `WebappUpdater`; the demo passes `undefined` and does not register PWA support. `Network` accepts a `SubsonicClientFactory` without changing Subsonic discovery, API-key login, or HTTPS enforcement. Alternate clients implementing `SubsonicApi`, such as the demo, explicitly select `{ protocol: "alternate" }` at the entry point; they own their protocol and skip Subsonic discovery/key resolution.

### Authentication and login validation

Settings exposes only **API key** and **Username and password**. `LoginMethod`/`LoginInput` in `src/auth.svelte.ts` accept only these two choices (`apiKey`/`token`); direct password is not an upfront selection. `src/auth.ts` retains three internal discriminated credential modes: API key, MD5 token/salt, and direct password, separate from the host and resolved username. Account/cache identity remains `(host, username)` across methods. Existing saved token/salt credentials migrate to `method: "token"` without forcing logout. Migration writeback is best-effort: if storage is full, use the validated credentials in memory and retain the saved legacy record for a later retry.

`AuthWorkflow` in `src/auth.svelte.ts` owns credential-free `getOpenSubsonicExtensions` discovery, credential preparation, API-key identity verification, fallback eligibility, and pending direct-password confirmation. Settings reads this workflow and invokes its login commands directly; after authentication resolves, `Session.connect()` accepts its verified identity/credentials and capability-configured cancellable candidate, then loads and activates the account workspace. Host/method/cancel actions use `Session.cancelConnect()` to cancel both the auth attempt and workspace preparation, never the selected offline workspace. Its `resetDiscovery: false` option retains discovery for retry; its `method` option delegates discovery-preserving method selection and cancellation to Auth. A cancelled or superseded result is rejected before any account cache loads. Session contains no auth-method policy or pending login secrets. `Network` owns candidate/live clients and metadata/media access, not discovery or login selection. `AuthStore` remains the persistence/migration owner, while `SubsonicClient` owns wire encoding, response validation, and protocol error shapes.

Advertised `apiKeyAuthentication` version 1 selects API key by default; otherwise username/password is selected. Users can switch between these two login choices. Username/password always tries MD5 token/salt first; Libras automatically detects explicit token rejection from that attempt, never from vendor/version heuristics. Only discovery HTTP `404`, `405`, or `501` establishes an unsupported endpoint and permits legacy login; network/CORS failures, malformed responses, and generic protocol errors remain errors. Capabilities are rediscovered on resume, not persisted or inferred from server names/versions.

API-key login first validates the key with `tokenInfo` and resolves its username before loading account-scoped storage. Explicit login then uses authenticated `ping()` to require a valid OpenSubsonic identity for every method; unknown server names are accepted. Saved API keys are revalidated on resume, including matching their saved username. Auth reports verification failures; Session keeps an unverified saved key's workspace offline and supplies recovery guidance without enabling metadata access. Protocol identity is not persisted. Structured `SubsonicError.code` drives fallback: only token rejection codes `41`/`42` offer direct password authentication. A warning explains that this sends the actual password over HTTPS rather than a derived token, and a separate confirmation action is required before sending it. Cancelling or switching host/login choice discards the pending password. Restored persisted passwords remain supported and require HTTPS. Invalid keys/credentials, timeouts, transport failures, and generic errors never trigger a silent downgrade.

`authenticationParameters` in `src/subsonic-client.ts` centralizes mutually exclusive wire parameters for metadata, artwork, and streaming: `apiKey` alone, `u`/`t`/`s`, or `u`/`p`. Hex passwords are encoding, not encryption or another method. API requests prefer form POST when `formPost` version 1 is advertised; artwork and streaming still use credential-bearing query URLs. Fetch exceptions and invalid JSON responses use credential-free errors; protocol error messages redact credential values and omit echoed URLs while retaining Subsonic codes. Media bodies use native Response handling. Avoid logging credential-bearing URLs, including in server/proxy access logs; HTTPS does not hide URLs from those servers.

`AuthStore` uses one injected `Storage`, defaulting to `localStorage`. All credentials, including API keys, replayable token/salt pairs, and direct passwords, persist until disconnect; they are not short-lived session tokens. This storage is JavaScript-readable and vulnerable to malicious scripts or compromised browser access. The demo explicitly injects its own memory storage. Disconnect clears credentials for every method and cancels pending secrets, while retaining the credential-free account identity, offline music, and queue.

Auth discovery/key requests share an attempt abort signal. Network owns candidate and active connection signals; Session guards workspace and sync publication against stale operations. Disconnect cancels both owners and never permits a late result to reenable access. Offline cache restoration has its own lifetime and survives disconnect.

### Library normalization

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
