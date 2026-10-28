# Libras website

This workspace (`@libras/website`) serves the static landing page and the full-width
Libras demo at `/demo/`. The installable server-backed player lives at `/webapp/`.

## Run

```sh
pnpm --filter @libras/website dev
# Open /demo/ on the printed URL. No login or separate server is needed.
pnpm --filter @libras/website build
```

The demo now injects `DeezerSubsonicClient` through the existing `Network` factory in
`demo.svelte`, together with synthetic auth and per-runtime memory preferences. The
shared App, library, artist/album pages, search, player and local queue are unchanged.
Its new `deezer-preview-demo` account identity separates it from the old static demo
and real accounts. Disconnect cannot switch the demo into a real account.

The minimal library is A Perfect Circle's _Mer De Noms_: **The Hollow**, **Judith**
(explicit), and **3 Libras**. See [Deezer integration notes](deezer-demo.md) for access,
approval, and remaining test limitations.

## Architecture

- `index.html` is a static landing page with a normal `/demo/` link, no player wrapper.
- `demo/index.html` and `main.ts` mount `demo.svelte` using the same styles, hash
  navigation, and app components as the regular player. Hot reload unmounts the app.
- `deezer-client.ts` implements the existing Subsonic transport interface in-browser,
  adapting an explicitly allowlisted album and three tracks into library metadata.
- `deezer-api.ts` uses the public API's JSONP transport because its JSON responses do
  not supply browser fetch CORS headers. It loads code only from a fixed HTTPS API
  with allowlisted paths; this is a third-party script trust boundary, not pure JSON.
- Playback resolves a fresh URL per source request. Signed URLs stay in memory, never
  in saved library/queue records. MP3 previews play directly from Deezer's CDN.
- Download actions and caching use the shared app's normal behavior. Downloads may
  not work with Deezer preview URLs; there is no demo-specific capability check.
- Attribution and source links are rendered as an HTML card in Settings, supplied by
  the demo through App's optional `settingsContent` snippet. Track labels identify
  previews and explicit content. Actual clip duration comes from the audio element,
  not the API's full-song duration and not an assumed 30 seconds.
- `client.ts` remains the original static adapter, with unchanged same-origin checks.
  Its fixtures/tests and `download-catalog.mjs` remain as legacy tooling, not the new
  demo's runtime data source.

## Builds and deployment

The regular app builds to root `dist/`; the website builds to `website/dist/`. The
website base defaults to `/`; `DEMO_BASE_PATH` changes it. Both website HTML entries
build without the PWA plugin. There is no demo manifest or service worker. The real
app's service worker remains scoped to `/webapp/`.

The existing Pages workflow still downloads the legacy full-audio export. Replacing
that workflow and its catalog verification is follow-up work in #79; the demo itself
no longer reads that export.

## Tests

`pnpm check` and `pnpm test` cover both workspaces. Deezer tests use synthetic metadata,
not live API/CDN requests, and cover pagination, cancellation, retries, fresh URL
resolution, restricted media origins, account isolation,
attribution, and the normal preconnected demo UI. Other browser/device playback still
requires manual verification.
