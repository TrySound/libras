# Libras website

This pnpm workspace (`@libras/website`) serves the static landing page at `https://libras-music.app/` and the full-width, preconnected demo at `https://libras-music.app/demo/`. The installable player lives at `https://libras-music.app/webapp/`.

## Architecture

- `index.html` contains the complete static landing page, feature illustrations, FAQ, calls to action, and SEO/social metadata. It has no JavaScript entry, live preview, or demo dialog. “Try live demo” is a normal link to `demo/`. `website.css` imports `src/edgerunner.css` directly and reuses its typography, row/stack utilities, semantic color roles, cards, and buttons. Only marketing layout, decorative illustrations, and website-specific sizing remain in the website stylesheet. Website rules stop at `.app-root` so they cannot restyle an embedded player. The landing page uses the same maroon/gold palette and self-hosted Rajdhani headings, with a preloaded bold font and system-color fallbacks for forced-colors mode.
- `demo/index.html` and `main.ts` mount Demo into `#app`, with the same `src/edgerunner.css`, dialog polyfill, full-width layout and hash navigation as the regular app. There is no marketing wrapper or `embedded` mode. Hot reload unmounts the component.
- `demo.svelte` constructs auth and network synchronously and renders the shared App directly, explicitly passing `undefined` for the updater. `DeezerSubsonicClient` is injected through the existing `Network` factory; library, settings, playback, downloads, errors and queue UI use the normal app components. Credits are HTML supplied through App's optional `settingsContent` snippet and rendered as a card in Settings.
- Cache/OPFS isolation comes from the synthetic `deezer-preview-demo` account identity, resolved against the website build base (not the `/demo/` page URL). The new username separates this library from the old static demo. Auth and preferences use a per-runtime `MemoryStorage` instance and never read or write localStorage.
- `deezer-client.ts` adapts the selected Deezer albums into the existing library pagination interface. It resolves current preview URLs at playback time; URLs are not persisted in library or queue records. Server-queue reads return empty and writes are ignored; the app's local playback queue is sufficient. The original `client.ts` static adapter and its same-origin checks remain unchanged, but are no longer used by `/demo/`.
- `vite.config.ts` builds both HTML entry points **without the PWA plugin**. There is no demo manifest, install prompt or service worker. The real app's service worker stays scoped to `/webapp/` and cannot control the website or demo. Directory-index output serves `/demo/` (and hosts can redirect `/demo` there).

Shared Settings allows disconnect, but the demo client factory rejects any different account before a cache can be selected. It cannot connect to real servers or touch their OPFS data. Reload the demo to restore its synthetic login and default preferences after disconnecting.

The demo loads metadata online on every launch. Auth and preferences reset on reload; the local playback queue remains persistent. Settings → Refresh library retries failed loads without losing the local library. Downloads and caching use the normal shared app behavior; downloads may not work with Deezer preview URLs.

## Deezer previews

The demo catalog for #79 contains two artists, two albums, and 16 previews:

- A Perfect Circle (artist **702**), _Mer De Noms_ (album **302117**): **The Hollow** (3135439), **Judith** (3135442, explicit), and **3 Libras** (3135444).
- Archive (artist **1334**), _Controlling Crowds (Parts I–III)_ (album **59667692**): all 13 tracks, including **Bullets** (476972632).

Exact album/track IDs and Settings credits are defined in `deezer-catalog.ts`. Album ordering is retained. Track labels identify previews and explicit content; Settings contains attribution and source links. The player measures actual clip duration instead of using the full-song duration.

`deezer-api.ts` uses JSONP at `https://api.deezer.com/` because the API did not provide browser fetch CORS headers during testing. JSONP executes third-party JavaScript with page privileges. Requests are limited to the selected album/tracks, with cancellation and a timeout. No Libras credentials are sent. Preview audio plays directly from Deezer's CDN; there is no proxy or separate backend process.

Approval is reported in #79; detailed conditions for JSONP access, metadata/artwork storage, and attribution are not recorded here. The larger catalog, unavailable-track UI, and deployment migration remain follow-up work in that issue.

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

## Pages deployment and secrets

**The Pages workflow still downloads and verifies the old static catalog, even though `/demo/` no longer reads it.** Until that workflow and `verify-build.mjs` are updated, deployment still requires the export and these **GitHub Actions repository secrets**:

- `DEMO_EXPORT_URL`: the private HTTPS export-directory URL (containing `latest.json`). Do not commit it, put it in a repository variable, or prefix it with `VITE_`.
- `DEMO_MEDIA_PASSWORD`: the private export password. HTTP Basic username defaults to `demo`.

The Pages workflow builds both workspaces, downloads the catalog into `website/dist/catalog/`, copies the website output to `pages/` and the app to `pages/webapp/`, and uploads one combined artifact. Secrets are scoped to the Node.js downloader—not the frontend build. It resolves `latest.json` once and uses that immutable release for the rest of the build; future deployments pick up the latest release.

`download-catalog.mjs` uses Node.js and `modern-tar` to verify the manifest fingerprint, archive SHA-256 and every extracted file. It rejects redirects, symlinks, hard links, path traversal, unexpected files, mixed releases and oversized archives. Missing secrets or verification failures fail deployment without replacing the live site. Errors are sanitized to avoid logging the private URL/password. Exports containing private source URLs/hostnames or credentials are rejected before publishing.

The legacy export's full music files, artwork, date provenance and credits remain publicly downloadable after deployment. Export credentials and private manifest URLs are not published. This export is separate from the Deezer API/CDN requests used by the demo.

To download a verified export locally, set the secrets privately (not in `website/public`), then run:

```sh
node website/download-catalog.mjs --output website/public/catalog
```

This is optional for local demo development. Never commit music or build-source credentials.

To reproduce the current Pages artifact locally, start without `website/public/catalog` (otherwise Vite copies it and the downloader refuses to overwrite it):

```sh
BASE_PATH=/webapp/ pnpm build
pnpm --filter @libras/website build
node website/download-catalog.mjs --output website/dist/catalog
rm -rf pages
mkdir -p pages/webapp
cp -a dist/. pages/webapp/
cp -a website/dist/. pages/
node website/verify-build.mjs --root pages
```

`verify-build.mjs` checks all three HTML entry points, required legacy catalog metadata and credits, PWA separation, a script-free landing page, and the 1 GiB size limit. Keep credits and licensing evidence with published export assets. PR CI builds both workspaces without private export access.

## Tests

`pnpm check` and `pnpm test` cover both workspaces. Tests cover static landing content, demo navigation and bootstrap, adapter pagination, cancellation, retries, fresh preview URL resolution, restricted media origins, Settings credits, in-memory preferences, account isolation, and no demo service-worker registration. They use synthetic metadata rather than live Deezer or private export requests. The original static adapter retains its own fixtures and tests.

A live headless Chromium check played the three A Perfect Circle previews (29.988563s each), sought The Hollow to 10s, and checked queue advancement after seeking near a clip's end. A subsequent check played Archive's Bullets (29.988563s) and sought it to 10s. This does not establish other browser/device behavior. Optional browser tests cover desktop/mobile layout and demo errors; their preview audio requests are aborted, so they do not verify successful playback.
