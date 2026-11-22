# Libras website

This pnpm workspace (`@libras/website`) serves the static landing page at `https://libras-music.app/` and the full-width, preconnected demo at `https://libras-music.app/demo/`. The installable player lives at `https://libras-music.app/webapp/`.

## Architecture

- `index.html` contains the complete static landing page, feature illustrations, FAQ, calls to action, and SEO/social metadata. It has no application JavaScript entry, live preview, or demo dialog. Plausible's public script and bootstrap are included directly in both website and demo HTML, without a shared bootstrap or custom host/path checks. The demo defers initialization to its entry point for query-route tracking. “Try live demo” is a normal link to `demo/`. `website.css` imports `src/edgerunner.css` directly and reuses its typography, row/stack utilities, semantic color roles, cards, and buttons. Only marketing layout, decorative illustrations, and website-specific sizing remain in the website stylesheet. Marketing rules are scoped to `.website`; the demo is a separate page. The landing page uses the same maroon/gold palette and self-hosted Rajdhani headings, with a preloaded bold font and system-color fallbacks for forced-colors mode.
- `demo/index.html` and `main.ts` mount Demo into `#app`, with the same `src/edgerunner.css`, dialog polyfill, full-width layout and query-based navigation as the regular app. There is no marketing wrapper. Hot reload unmounts the component.
- `demo.svelte` constructs auth and network synchronously and renders the shared App directly, explicitly passing `undefined` for the updater and enabling demo-specific connection guidance. `DeezerSubsonicClient` is injected through the existing `Network` factory; library, settings, playback, downloads, errors and queue UI use the normal app components. Credits are HTML supplied through App's optional `settingsContent` snippet and rendered as a card in Settings: Deezer attribution followed by one linked artist/album/year entry per album, without a track-by-track list.
- Cache/OPFS isolation comes from the synthetic `deezer-preview-demo` account identity, resolved against the website build base (not the `/demo/` page URL). Auth and preferences use a per-runtime `MemoryStorage` instance and never read or write localStorage.
- `deezer-client.ts` adapts the committed catalog snapshot into the existing library pagination interface, without live album requests during sync. It resolves current preview URLs at playback time; playback URLs are not persisted in library or queue records. Server-queue reads return empty and writes are ignored; the app's local playback queue is sufficient.
- `vite.config.ts` builds both HTML entry points **without the PWA plugin**. There is no demo manifest, install prompt or service worker. The real app's service worker stays scoped to `/webapp/` and cannot control the website or demo. Directory-index output serves `/demo/` (and hosts can redirect `/demo` there).

Shared Settings allows disconnect; the demo's disconnected view offers Reload demo instead of a server login form. Its connection copy explains the fixed library. The demo client factory still rejects any different account before a cache can be selected. It cannot connect to real servers or touch their OPFS data. Reload the demo to restore its synthetic login and default preferences after disconnecting.

The demo synchronizes metadata from the snapshot shipped with the website, so browsing does not depend on Deezer API availability or regional album responses. Auth and preferences reset on reload; the local playback queue remains persistent. Settings → Refresh library rereads that snapshot without losing the queue. Updating the committed catalog requires rebuilding the website. Existing demo caches pick up changed artist artwork IDs with Settings → Refresh library. Downloads and caching use the normal shared app behavior; downloads may not work with Deezer preview URLs.

## Deezer previews

The committed catalog contains **16 artists, 53 albums, and 663 previews**. The selection and edition metadata live in `deezer-catalog.json`; see #79 for selection history.

`deezer-catalog.json` contains the exact recording IDs, titles, explicit flags, original release years, year-source links and artwork URLs used by the adapter and Settings credits. Each album entry also carries `artistArtwork`: a committed artist-photo URL shared by every album from that artist. The adapter maps these photos to distinct `artist:<id>` artwork keys through the existing `getCoverArtUrl()` method; album and track artwork IDs and images are unchanged. Artwork is loaded directly from Deezer's image CDN; no image files are committed, and browsing makes no live artist metadata requests. `deezer-catalog.ts` exports that data. Original years are curated independently of Deezer edition dates, which are retained separately as `sourceReleaseDate`. Album ordering and selected edition labels (including Deluxe and anniversary/remaster labels) are preserved. The player measures actual clip duration instead of using the full-song duration. The demo adapter includes preview/explicit information in its track titles; the shared UI displays those names as supplied, without interpreting them as badges.

To refresh the committed metadata and artist photos from the explicit edition list:

```sh
node website/refresh-deezer-catalog.mjs
```

The script refreshes album metadata, checking artist/album relationships, unique recording IDs, preview availability and expected counts. It then fetches `/artist/{id}` once per unique artist, with the same sequential request throttling. It validates artist identity and selects `picture_big`, falling back to `picture_medium` when absent. Missing photos, non-HTTPS URLs, non-`cdn-images.dzcdn.net` origins and embedded credentials fail the refresh before the JSON is replaced. Artist enrichment adds only `artistArtwork` to the validated album data. The script stores no preview URLs, tokens or audio. Review the generated diff, including any live album/track metadata drift, before committing; CI uses the snapshot and synthetic responses, not live requests.

`deezer-api.ts` uses JSONP at `https://api.deezer.com/` because the API did not provide browser fetch CORS headers during testing. JSONP executes third-party JavaScript with page privileges. Only selected track lookups are allowed at playback time, with cancellation and a timeout. Returned recording, artist and album IDs must match the selection; an unexpected response reports the affected recording and IDs. No Libras credentials are sent. Preview audio plays directly from Deezer's CDN; there is no proxy or separate backend process.

Approval is reported in #79; detailed conditions for JSONP access, metadata/artwork storage, and attribution are not recorded here. Unavailable-track UI remains follow-up work in that issue.

## Website analytics

The landing page uses the public site snippet from `https://analytics.trysound.io` for `libras-music.app`. This is a new integration, not a Cloud migration; no historical import is included. The live demo (`/demo/`) includes a separate bootstrap in its own HTML entry point and initializes it from `demo-analytics.ts` after the Navigation API (native or polyfilled) is ready, without modifying shared app code. The real player (`/webapp/`) contains no analytics integration.

Plausible records pageviews automatically. Button-shaped links use its declarative event classes, with four event names: `Connect server`, `Try demo`, `GitHub`, and `Setup requirements`. The `placement` property distinguishes the header, hero, servers, open-source, and bottom sections. These are **clicks**, not completed connections or demo sessions. Plausible adds each clicked link's public destination URL; no account, server, music, or search data is supplied. The landing page's generated tracker also supports automatic outbound-link and engagement tracking. Links and content still work if scripts are disabled or blocked.

The demo disables automatic pageviews and records its initial screen plus committed Navigation API screen changes, including Back/Forward. `demo-analytics.ts` normalizes query routes to `/demo/library`, `/demo/artist`, `/demo/album`, `/demo/search`, `/demo/settings`, and `/demo/downloads` (respecting the build base). IDs, search text, other query parameters, and fragments are omitted; referrer queries/fragments are also removed. Unknown routes use the router's Library fallback. Each distinct route counts as a pageview, including switching between artists or albums, but only the screen type is transmitted. Typing search queries or changing anchors does not add pageviews. Plausible's other tracking defaults are retained; automatic events and standard engagement use normalized page URLs. There is no additional player-action instrumentation. Landing-page tracking is unchanged.

In the Plausible dashboard, add custom-event goals matching those four names exactly to see conversions. After deployment, verify a pageview and representative button click in the dashboard. The snippet loads in all environments. Plausible ignores localhost by default, but remote preview and self-hosted deployments have no project-level exclusion. There is no pending history import recorded for this integration; if one is needed, complete it before deploying.

## Local development

No catalog export, Deezer login, or separate server is needed to run `/demo/`.

```sh
pnpm install
pnpm --filter @libras/website dev
# Open the printed URL for the landing page, or /demo/ for the player.
pnpm check
pnpm test
pnpm build
pnpm --filter @libras/website build
pnpm --filter @libras/website preview
```

The regular app builds to root `dist/`; the website builds to `website/dist/`, including `demo/index.html`. The builds do not clear each other's output. The website base defaults to `/`; `DEMO_BASE_PATH` can change it. The shared `inlineSvgSprite()` plugin injects `src/sprite.svg` into each HTML entry. Icons use local symbol references, preserving SMIL animations without putting geometry in JavaScript.

## Pages deployment

The Pages workflow builds both workspaces, copies the website output to `pages/` and the app to `pages/webapp/`, verifies the combined artifact, and uploads it. The demo's metadata snapshot is committed; artwork and preview audio are loaded directly from Deezer's CDNs. No catalog export, self-hosted music or private export credentials are needed to build or deploy.

To reproduce the Pages artifact locally:

```sh
BASE_PATH=/webapp/ pnpm build
pnpm --filter @libras/website build
rm -rf pages
mkdir -p pages/webapp
cp -a dist/. pages/webapp/
cp -a website/dist/. pages/
node website/verify-build.mjs --root pages
```

`verify-build.mjs` checks all three HTML entry points, PWA separation and `/webapp/` scope, a landing page without the demo application bundle, and the 1 GiB size limit. It rejects any leftover root `catalog/` export so old music files cannot accidentally be published. If you still have a local `website/public/catalog/` directory from the previous demo, move it outside `public/` or remove it before building. The landing page's Music credits link opens the demo's Settings card.

## Tests

`pnpm check` and `pnpm test` cover both workspaces. Tests cover static landing content, demo navigation and bootstrap, adapter pagination, cancellation, API-independent sync, playback errors, fresh preview URL resolution, restricted media origins, Settings credits, in-memory preferences, account isolation, and no demo service-worker registration. They use synthetic metadata and stubbed responses rather than live Deezer requests. Build verification tests cover the combined artifact, PWA separation and rejection of legacy catalog exports.

Live headless Chromium checks cover library sync, representative previews, seeking and queue advancement. This does not establish playback for every recording or other browser/device behavior. Optional browser tests verify script-free landing layout, keyboard focus and FAQ interaction, plus track lists and years for all 53 albums with Deezer API access blocked, desktop/mobile layout and playback errors. Their preview audio requests are aborted, so they do not verify successful playback. See [CONTRIBUTING.md](../CONTRIBUTING.md#optional-browser-suites) for commands.
