# Minimal Deezer demo (#79)

The existing `/demo/` UI uses `DeezerSubsonicClient` through its injected `Network`
factory and synthetic auth. There is no separate server or player.

## Catalog

A Perfect Circle (artist **702**), _Mer De Noms_ (album **302117**):

- **3135439** — The Hollow
- **3135442** — Judith (explicit)
- **3135444** — 3 Libras

Album ordering is retained. Preview and explicit-content labels appear in track
names; source links and attribution are in the Settings credits card.

## Access and storage

The public API did not provide browser fetch CORS headers during testing, so this
example uses its JSONP transport at `https://api.deezer.com/`. JSONP executes
third-party JavaScript with page privileges. Requests are limited to the selected
album/tracks, with cancellation and a timeout. No Libras credentials are sent.

`getStreamUrl` looks up the selected track on each playback request and returns its
current preview URL. Audio plays directly from Deezer's CDN; URLs are not saved in
the library or queue. The player measures clip duration rather than using the full
song's duration. Download actions and caching retain the shared app's normal
behavior; downloads may not work with Deezer preview URLs.

Approval is reported in #79; detailed conditions are not recorded here. JSONP access,
metadata/artwork storage, and attribution requirements still need confirmation for
the full rollout. The Pages workflow still uses the old static catalog export.

## Verification

Synthetic tests cover the adapter, demo UI, cancellation, retries, URL validation,
and network integration. A live headless Chromium check played all three
clips (29.988563s each), sought The Hollow to 10s, and checked queue advancement after
seeking near a clip's end. This does not establish other browser/device behavior.

The larger catalog, unavailable-track UI, and deployment migration remain follow-up
work in #79.
