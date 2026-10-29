# Libras website

This pnpm workspace (`@libras/website`) serves the static landing page at `https://libras-music.app/` and the full-width, preconnected demo at `https://libras-music.app/demo/`. The installable player lives at `https://libras-music.app/webapp/`.

## Architecture

- `index.html` contains the complete static landing page, feature illustrations, FAQ, calls to action, and SEO/social metadata. It has no JavaScript entry, live preview, or demo dialog. “Try live demo” is a normal link to `demo/`. `website.css` imports `src/edgerunner.css` directly and reuses its typography, row/stack utilities, semantic color roles, cards, and buttons. Only marketing layout, decorative illustrations, and website-specific sizing remain in the website stylesheet. Website rules stop at `.app-root` so they cannot restyle an embedded player. The landing page uses the same maroon/gold palette and self-hosted Rajdhani headings, with a preloaded bold font and system-color fallbacks for forced-colors mode.
- `demo/index.html` and `main.ts` mount Demo into `#app`, with the same `src/edgerunner.css`, dialog polyfill, full-width layout and hash navigation as the regular app. There is no marketing wrapper or `embedded` mode. Hot reload unmounts the component.
- `demo.svelte` constructs auth and network synchronously and renders the shared App directly, explicitly passing `undefined` for the updater. `DeezerSubsonicClient` is injected through the existing `Network` factory; library, settings, playback, downloads, errors and queue UI use the normal app components. Credits are HTML supplied through App's optional `settingsContent` snippet and rendered as a card in Settings: Deezer attribution followed by one linked artist/album/year entry per album, without a track-by-track list.
- Cache/OPFS isolation comes from the synthetic `deezer-preview-demo` account identity, resolved against the website build base (not the `/demo/` page URL). Auth and preferences use a per-runtime `MemoryStorage` instance and never read or write localStorage.
- `deezer-client.ts` adapts the committed catalog snapshot into the existing library pagination interface, without live album requests during sync. It resolves current preview URLs at playback time; playback URLs are not persisted in library or queue records. Server-queue reads return empty and writes are ignored; the app's local playback queue is sufficient.
- `vite.config.ts` builds both HTML entry points **without the PWA plugin**. There is no demo manifest, install prompt or service worker. The real app's service worker stays scoped to `/webapp/` and cannot control the website or demo. Directory-index output serves `/demo/` (and hosts can redirect `/demo` there).

Shared Settings allows disconnect, but the demo client factory rejects any different account before a cache can be selected. It cannot connect to real servers or touch their OPFS data. Reload the demo to restore its synthetic login and default preferences after disconnecting.

The demo synchronizes metadata from the snapshot shipped with the website, so browsing does not depend on Deezer API availability or regional album responses. Auth and preferences reset on reload; the local playback queue remains persistent. Settings → Refresh library rereads that snapshot without losing the queue. Updating the catalog requires regenerating the metadata and rebuilding the website. Downloads and caching use the normal shared app behavior; downloads may not work with Deezer preview URLs.

## Deezer previews

The demo includes the full revised shortlist from #79: **16 artists, 53 albums, and 663 previews**, excluding Puscifer. _Mer De Noms_ now includes all 12 tracks rather than the initial three.

Artists: A Perfect Circle, Archive, Arctic Monkeys, Breaking Benjamin, Foo Fighters, Metric, Nothing But Thieves, Poets of the Fall, Queens of the Stone Age, Radiohead, Röyksopp, Seether, Shinedown, Soundgarden, The xx, and TOOL.

Breaking Benjamin replaces Audioslave with _We Are Not Alone_ (2004; 12-track Deezer edition including the alternate Rain (2005)), _Phobia (Explicit Version)_ (2006), and _Dear Agony_ (2009).

Seether includes _Disclaimer II_ (2004, 20 tracks), _Karma and Effect_ (2005, 14 tracks), and _Finding Beauty In Negative Spaces (Bonus Track Version)_ (2007, 14 tracks). Shinedown includes _The Sound of Madness_ (2008, the 20-track edition with bonus recordings), _Amaryllis_ (2012, 12 tracks), and _ATTENTION ATTENTION_ (2018, 14 tracks).

`deezer-catalog.json` contains the exact recording IDs, titles, explicit flags, original release years, year-source links and artwork URLs used by the adapter and Settings credits. Artwork is loaded directly from Deezer's image CDN; no image files are committed. `deezer-catalog.ts` exports that data. Original years are curated independently of Deezer edition dates, which are retained separately as `sourceReleaseDate`. Album ordering and selected edition labels (including Deluxe and anniversary/remaster labels) are preserved. The player measures actual clip duration instead of using the full-song duration.

To refresh the committed metadata from the explicit edition list:

```sh
node website/refresh-deezer-catalog.mjs
```

The script checks artist/album relationships, unique track IDs, preview availability and the expected counts before replacing the JSON. It stores no preview URLs, tokens or audio. Review the generated diff before committing; CI uses the snapshot and synthetic responses, not live requests.

`deezer-api.ts` uses JSONP at `https://api.deezer.com/` because the API did not provide browser fetch CORS headers during testing. JSONP executes third-party JavaScript with page privileges. Only selected track lookups are allowed at playback time, with cancellation and a timeout. Returned recording, artist and album IDs must match the selection; an unexpected response reports the affected recording and IDs. No Libras credentials are sent. Preview audio plays directly from Deezer's CDN; there is no proxy or separate backend process.

Approval is reported in #79; detailed conditions for JSONP access, metadata/artwork storage, and attribution are not recorded here. Unavailable-track UI remains follow-up work in that issue.

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

`verify-build.mjs` checks all three HTML entry points, PWA separation and `/webapp/` scope, a script-free landing page, and the 1 GiB size limit. It rejects any leftover root `catalog/` export so old music files cannot accidentally be published. If you still have a local `website/public/catalog/` directory from the previous demo, move it outside `public/` or remove it before building. The landing page's Music credits link opens the demo's Settings card.

The obsolete `DEMO_EXPORT_URL` and `DEMO_MEDIA_PASSWORD` repository secrets are no longer used and can be removed from GitHub settings.

## Tests

`pnpm check` and `pnpm test` cover both workspaces. Tests cover static landing content, demo navigation and bootstrap, adapter pagination, cancellation, API-independent sync, playback errors, fresh preview URL resolution, restricted media origins, Settings credits, in-memory preferences, account isolation, and no demo service-worker registration. They use synthetic metadata and stubbed responses rather than live Deezer requests. Build verification tests cover the combined artifact, PWA separation and rejection of legacy catalog exports.

Live headless Chromium checks cover library sync, representative previews, seeking and queue advancement. This does not establish playback for every recording or other browser/device behavior. Optional browser tests verify track lists and years for all 53 albums with Deezer API access blocked, desktop/mobile layout and playback errors; their preview audio requests are aborted, so they do not verify successful playback.
