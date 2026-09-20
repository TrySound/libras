# Static Libras demo

This pnpm workspace (`@libras/website`) imports the existing application from `../src` and serves a preconnected demo at `/libras/demo/`. All demo-specific code lives here. No real server, API token, password or export-source URL is used by the browser.

## Architecture

- `client.ts` owns lazy loading of `search3.json` through the shared Subsonic response schema and the `assets.json` path map. Clients reuse successfully loaded metadata when given the same catalog-base URL object, keeping reconnects fast and separate demo mounts isolated; failed loads can be retried and aborted clients cannot publish stale data. It implements independent library pagination, original audio/artwork URLs and cancellation without intercepting global fetch or emulating `/rest` endpoints. Server-queue reads return empty and writes are ignored; the app's local playback queue is sufficient. The exporter checks IDs, relationships, credits, durations and asset integrity before publishing.
- `demo.svelte` constructs auth and network synchronously and renders App directly, explicitly passing `undefined` for the updater. There is no separate asynchronous bootstrap UI. Cache/OPFS isolation comes from the separate demo account identity; preferences and auth share a per-runtime `MemoryStorage` instance, with the class defined in this component and never read or write localStorage. App's inline preference setup uses the injected auth store's storage scope, not a separate prop.
- `vite.config.ts` is a separate build **without the PWA plugin**. There is no manifest, install prompt or demo service worker. Do not unregister the regular app's worker: its broader scope may control this URL, but its navigation fallback excludes the demo and does not cache demo assets.
- Settings, header, title, playback, explicit downloads and library UI stay inline in the shared app. There is no demo-specific wrapper UI around App; music credits remain available at `catalog/credits.html`. Shared Settings still allows disconnect, but the static client factory rejects any different account before a cache can be selected; it cannot connect to real servers or touch their OPFS data. Reload the demo to restore its synthetic login and default preferences after disconnecting.

The demo loads its catalog online on every launch. Auth and preferences reset on reload. OPFS-backed downloads and the app's local playback queue remain persistent; opening/reloading the demo offline is not supported. Catalog loading and failures use the shared app's synchronization UI; Settings → Refresh library retries failed loads without losing the local library. All full-length tracks are served unchanged; there is no transcoding. Unsupported formats report an error instead of pretending that OGG bytes are an MP3.

## Local development

Place a verified complete export in `website/public/catalog/` (ignored by Git), including audio, covers, `search3.json`, `assets.json`, credits and provenance. Never commit music or build-source credentials.

```sh
pnpm install
pnpm --filter @libras/website dev
# Open the URL printed by Vite, followed by /libras/demo/.
pnpm check
pnpm test
pnpm build
pnpm --filter @libras/website build
pnpm --filter @libras/website preview
```

Each workspace uses Vite's normal defaults: the regular application builds to root `dist/`, while the website builds to `website/dist/`. The builds are independent and do not clear each other's output. Commands run in the website package directory, so its Vite config only sets the base URL, Svelte plugin, and shared sprite plugin—no custom root, public directory, or output path. The demo base defaults to `/libras/demo/`; `DEMO_BASE_PATH` can change it. Public catalog URLs are resolved against that base, never against a secret build-source location. The shared `inlineSvgSprite()` plugin from `build/inline-svg-sprite.ts` injects `src/sprite.svg` once into the HTML. The shared app's typed `Icon` component uses local symbol references, preserving SMIL animations without putting icon geometry in JavaScript. There is no copied sprite source or website-specific injection implementation.

The Pages workflow assembles the website output under `dist/demo/` after both packages build.

A separate CI build step supplies the export via secrets before publishing. A code-only build is useful for CI but is not a playable deployment until its catalog is present. Keep `catalog/credits.html`, machine-readable credits and licensing evidence with the published assets.

## Tests

The tests here cover client pagination, the real Network integration, aborts, artwork/audio URLs, original-format behavior, shared response parsing, same-origin media URL enforcement, no-op server queues, isolated in-memory preferences, preference reset and preconnected app bootstrap without service-worker registration. They use tiny synthetic metadata rather than contacting the export source.
