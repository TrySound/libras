# Minimal Deezer demo integration (#79)

This is the existing `/demo/` App with its `Network` factory and synthetic auth
overridden, not another backend process or audio player. Start the website workspace
and open `/demo/` to browse/play the three selected recordings.

## Scope and permission record

The maintainer reports Deezer approval in #79. Exact conditions for own-player
playback, attribution, metadata/artwork storage, territories, and audio caching have
not yet been recorded in this repository. Confirm those conditions before publication;
accessible CDN URLs are not independent permission. Do not publish private approval
correspondence or credentials.

Explicit allowlist: artist **702**, album **302117** (_Mer De Noms_), tracks
**3135439** (The Hollow), **3135442** (Judith, explicit), **3135444** (3 Libras).
Album API order is retained. No original release year is asserted.

## Runtime boundaries

The adapter loads album metadata on connection and returns one artist, one album and
three tracks through ordinary library pagination. Refresh library retries a failed
connection. It does not weaken `StaticSubsonicClient`'s same-origin checks.

The public Deezer API response lacks browser fetch CORS headers in the access check.
For this no-server example, the fixed `https://api.deezer.com/` JSONP endpoint is used.
**JSONP executes third-party JavaScript with page privileges.** Only the four explicit
API paths are allowed, callbacks are unique, requests time out, and cancellation
removes scripts and ignores stale responses. No SDK, proxy, login or credentials are
used. Script requests may carry browser-managed Deezer cookies according to browser
policy; no Libras credentials are sent. Review this access model against the approval
before production; do not bypass regional/authentication restrictions with a proxy.

A track lookup occurs for each playback source, not at build time. Only the exact
`https://cdnt-preview.dzcdn.net` origin is accepted for audio, and the exact
`https://cdn-images.dzcdn.net` origin for artwork. Changes to those endpoints fail
closed until reviewed. Playback URLs remain transient, while saved queues contain
track IDs. URL lifetime and the supported production refresh contract remain
unconfirmed; per-source lookup is the experiment's refresh strategy, not a permanence
assumption. There are no background retries or self-cut/rehosted audio clips.

The new synthetic account prevents old demo caches mixing with this catalog. Audio
cache reads/writes, downloads and prefetch through the app are blocked at engine and
network boundaries. Normal browser media buffering remains. Metadata/artwork are
still cached by shared components; confirm those permissions before public use.

Previews and explicit tracks are labeled, attribution/source links appear in the
Settings credits card, and Libras measures actual clip duration. Original full-song duration is deliberately not
used for the player's progress. The normal playback queue handles clip completion.
A removed/unreadable/region-restricted preview yields a controlled playback error;
full unavailable-track affordances and queue-error policy remain follow-up work.

## Verification and rollout gates

Automated tests use synthetic responses, including UI mounting, pagination, failure
retry, abort/stale results, per-play URL lookup, URL validation and blocked audio
storage. They do not establish actual decoding or territory availability.

A live headless Chromium smoke check from this development host loaded all three
tracks through `/demo/`, decoded/played each clip (reported duration 29.988563s),
sought The Hollow to 10s, and advanced to the next queue entry after seeking near the
clip's end. This is not a Serbia or mobile-browser check. Synthetic desktop/mobile
layout and demo-error browser tests also pass against the production website build.

Before a public switch, verify on desktop and mobile target browsers:

- All three recordings decode, reach their natural end and advance the queue.
- Actual clip duration, forward/backward seeking, audio/artwork CORS, and errors.
- Serbia and representative permitted visitor territories, not just this server.
- Expired URLs recover through a new playback request without infinite retries.
- Required attribution, storage permissions, and supported URL-refresh access model.

Stop exposing the demo route or remove the selected IDs to take previews down. This
small example does not implement the 605-track pipeline, deployment switch, complete
unavailability UX, or the final approval/territorial handling from issue #79.
