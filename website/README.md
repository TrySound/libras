# Static Libras demo

This entry point imports the existing application from `../src` and serves a preconnected demo at `/libras/demo/`. All demo-specific code lives here. No real server, API token, password or export-source URL is used by the browser.

## Architecture

- `catalog.ts` validates the static `search3.json` / `assets.json` export, normalizes its legacy credits and restricts media to relative same-origin paths.
- `client.ts` implements the shared OpenSubsonic client surface: independent library pagination, original audio/artwork URLs, cancellation and a locally persisted simulated server queue. It does not intercept global fetch or emulate `/rest` HTTP endpoints.
- `demo.svelte` supplies a public synthetic account, client factory, isolated storage and demo settings to the real application. Cache/OPFS isolation comes from the separate demo account identity; preferences, auth and the simulated remote queue use a demo-prefixed localStorage adapter.
- `vite.config.ts` is a separate build **without the PWA plugin**. There is no manifest, install prompt or demo service worker. Do not unregister the regular app's worker: its broader scope may control this URL, but its navigation fallback excludes the demo and does not cache demo assets.
- `settings.svelte` replaces server credentials/disconnect controls with demo information, credits and the normal refresh/offline-library controls. Playback, explicit downloads, search and library UI are shared with the app.

The demo loads its catalog online on every launch. Local state/downloads survive reloads, but opening/reloading the demo offline is not supported. Catalog failures present a retry screen rather than a login screen or empty library. All full-length tracks are served unchanged; there is no transcoding. Unsupported formats report an error instead of pretending that OGG bytes are an MP3.

## Local development

Place a verified complete export in `website/public/catalog/` (ignored by Git), including audio, covers, `search3.json`, `assets.json`, credits and provenance. Never commit music or build-source credentials.

```sh
pnpm dev:demo
# Open the URL printed by Vite, followed by /libras/demo/.
pnpm check
pnpm test
pnpm build
pnpm build:demo
pnpm preview:demo
```

`build:demo` writes only `dist/demo/`, preserving the regular build in `dist/`. Run the regular build first because it clears `dist/`. The demo base defaults to `/libras/demo/`; `DEMO_BASE_PATH` can change it. Public catalog URLs are always resolved against that base, never against a secret build-source location. Icon symbols are reused from the regular app's HTML at build time.

A separate CI build step supplies the export via secrets before publishing. A code-only build is useful for CI but is not a playable deployment until its catalog is present. Credits are linked from the demo header and settings; keep credits and licensing evidence with the published assets.

## Tests

The tests here cover client pagination, the real Network integration, aborts, artwork/audio URLs, original-format behavior, credit normalization, unsafe asset rejection, queue persistence, storage isolation and preconnected app bootstrap without service-worker registration. They use tiny synthetic metadata rather than contacting the export source.
