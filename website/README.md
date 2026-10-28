# Libras website

This pnpm workspace (`@libras/website`) serves the static landing page at `https://libras-music.app/` and the full-width, preconnected demo at `https://libras-music.app/demo/`. The installable player lives at `https://libras-music.app/webapp/`. No real server, API token, password or export-source URL is used by the demo browser client.

## Architecture

- `index.html` contains the complete static landing page, feature illustrations, FAQ, calls to action, and SEO/social metadata. It has no JavaScript entry, live preview, or demo dialog. “Try live demo” is a normal link to `demo/`. `website.css` imports the legacy website foundations from `src/app.css`; no player stylesheet is loaded on the landing page.
- `demo/index.html` and `main.ts` mount Demo into `#app`, with the same `src/edgerunner.css`, dialog polyfill, full-width layout and hash navigation as the regular app. There is no marketing wrapper or `embedded` mode. Hot reload unmounts the component.
- `demo.svelte` constructs auth and network synchronously and renders the shared App directly, explicitly passing `undefined` for the updater. The static network adapter is the demo's data source; layout, settings, playback, downloads, errors and library UI are the normal app components.
- Cache/OPFS isolation comes from the existing synthetic demo account identity, resolved against the website build base (not the `/demo/` page URL). Auth and preferences use a per-runtime `MemoryStorage` instance and never read or write localStorage. Moving the demo page does not change its catalog URLs or account identity.
- `client.ts` lazily loads `catalog/search3.json` through the shared Subsonic response schema and the `assets.json` path map. Clients reuse successfully loaded metadata for the same catalog-base URL object. Failed loads can be retried; aborted clients cannot publish stale data. It implements library pagination, original audio/artwork URLs and cancellation without intercepting global fetch or emulating `/rest` endpoints. Server-queue reads return empty and writes are ignored; the app's local playback queue is sufficient.
- `vite.config.ts` builds both HTML entry points **without the PWA plugin**. There is no demo manifest, install prompt or service worker. The real app's service worker stays scoped to `/webapp/` and cannot control the website or demo. Directory-index output serves `/demo/` (and hosts can redirect `/demo` there).

Shared Settings allows disconnect, but the static client factory rejects any different account before a cache can be selected. It cannot connect to real servers or touch their OPFS data. Reload the demo to restore its synthetic login and default preferences after disconnecting.

The demo loads its catalog online on every launch. Auth and preferences reset on reload. OPFS-backed downloads and the local playback queue remain persistent; opening/reloading the demo offline is not supported. Settings → Refresh library retries failed loads without losing the local library. Full-length tracks are served unchanged, without transcoding. Unsupported formats report an error. Music credits remain at `/catalog/credits.html`.

## Local development

Place a verified complete export in `website/public/catalog/` (ignored by Git), including audio, covers, `search3.json`, `assets.json`, credits and provenance. Never commit music or build-source credentials.

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

The regular app builds to root `dist/`; the website builds to `website/dist/`, including `demo/index.html`. The builds do not clear each other's output. The website base defaults to `/`; `DEMO_BASE_PATH` can change it. Catalog URLs resolve against that base, never a secret build-source location. The shared `inlineSvgSprite()` plugin injects `src/sprite.svg` into each HTML entry. Icons use local symbol references, preserving SMIL animations without putting geometry in JavaScript.

## Pages deployment and secrets

Configure these **GitHub Actions repository secrets**:

- `DEMO_EXPORT_URL`: the private HTTPS export-directory URL (containing `latest.json`). Do not commit it, put it in a repository variable, or prefix it with `VITE_`.
- `DEMO_MEDIA_PASSWORD`: the private export password. HTTP Basic username defaults to `demo`.

The Pages workflow builds both workspaces, downloads the catalog into `website/dist/catalog/`, copies the website output to `pages/` and the app to `pages/webapp/`, and uploads one combined artifact. Secrets are scoped to the Node.js downloader—not the frontend build. It resolves `latest.json` once and uses that immutable release for the rest of the build; future deployments pick up the latest release.

`download-catalog.mjs` uses Node.js and `modern-tar` to verify the manifest fingerprint, archive SHA-256 and every extracted file. It rejects redirects, symlinks, hard links, path traversal, unexpected files, mixed releases and oversized archives. Missing secrets or verification failures fail deployment without replacing the live site. Errors are sanitized to avoid logging the private URL/password. Exports containing private source URLs/hostnames or credentials are rejected before publishing.

The browser receives only public same-origin catalog paths, never export credentials or manifest URLs. Public artist/license source links are deliberately retained as attribution. Full music files, artwork, date provenance and credits become publicly downloadable after deployment.

For local development, set the secrets privately (not in `website/public`), then run:

```sh
node website/download-catalog.mjs --output website/public/catalog
pnpm --filter @libras/website dev
```

To reproduce a release locally, start without `website/public/catalog` (otherwise Vite copies it and the downloader refuses to overwrite it):

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

`verify-build.mjs` checks all three HTML entry points, required catalog metadata and credits, PWA separation, a script-free landing page, and the 1 GiB size limit. The exporter validates catalog schema and asset relationships. A code-only build is not playable until its catalog is present. Keep credits and licensing evidence with published assets. PR CI builds both workspaces without private export access.

## Tests

Tests cover static landing content and icons, demo CTA URLs, standalone demo bootstrap and cleanup, client pagination, Network integration, cancellation, artwork/audio URLs, original-format behavior, response parsing, same-origin asset enforcement, no-op server queues, in-memory preferences, account isolation, catalog retry and no service-worker registration. They use synthetic metadata rather than the export source. Optional browser tests cover page navigation, full-width desktop/mobile layout, playback and errors.
