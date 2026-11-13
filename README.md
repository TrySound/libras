<p align="center">
  <img src="public/logo.svg" alt="Libras logo" width="120" height="120" />
</p>

<h1 align="center">Libras</h1>

Libras is a browser-based minimalistic music player that connects to your own music server. Browse your library, play music, and download tracks to take with you.

> Named after “3 Libras” by A Perfect Circle.

![Libras music player interface](website/public/screenshots/hero.webp)

## Features

- Browse and search artists, albums, and tracks together in Library, with shareable multi-select type filters. Older Search links keep their criteria.
- Stream music from your own server.
- Download music for offline playback and manage it in Settings → Downloads.
- Restore this device’s playback queue and position between sessions, without autoplay.
- Explicitly Load server queue or Save queue to server from Queue in navigation. Startup, reconnect, library refresh and playback never exchange server queues. Loading confirms replacement and stops playback only after a valid result arrives; failed/stale loads leave local state intact. Saving an empty queue confirms clearing the server queue. Duplicate and unavailable IDs are retained; Subsonic selection uses a track ID, so duplicate occurrences are ambiguous (the local occurrence is retained when membership matches, otherwise the first match is selected). The demo has no server queue exchange.
- Install as a standalone web app.

## Get started

1. Open [Libras](https://libras-music.app/webapp/).
2. Connect to your music server with your server address, username, and password.
3. Browse or search Library and start listening. Settings links back to the focused connection screen for sign-in.

**Play now** replaces the queue with that track only, or the chosen collection in its current scope. **Play next** inserts after the selected occurrence; **Add to queue** appends. Neither starts an inactive queue. Queue removal preserves other occurrences (including duplicates and unavailable tracks); removing the selected occurrence stops playback without choosing a replacement.

Just trying it out? Connect to the [Navidrome demo server](https://demo.navidrome.org/) using `https://demo.navidrome.org` as the server address and `demo` as both the username and password.

You'll need a reachable **HTTPS server with a Subsonic-compatible API**, such as [Navidrome](https://www.navidrome.org/), supporting OpenSubsonic's empty-query `search3` for library synchronization and configured to allow browser requests from `https://libras-music.app` (CORS). Libras is a player, not a music hosting service; bring your own server and library.

### Browser support

Safari 26.0 or newer is required; older Safari versions are not supported. The app uses native URLPattern, OPFS writable files, and Web Locks. Without Web Locks, account activation is blocked rather than risking conflicting writes. Safari 26.0–26.1 load Navigation API and invoker commands polyfills on demand; Safari 26.2+ use the native APIs. The dialog `closedby` polyfill and relative `rgb()` colors remain necessary for Safari 26. The standalone styleguide uses native browser features without polyfills.

### Authentication and device storage

Libras tries salted token authentication first; your password stays in the browser for that attempt. Only a structured server rejection of token authentication (Subsonic code 41 or 42) automatically retries the same username and password over HTTPS, including on localhost. Invalid credentials, connection failures, and other errors never trigger a password retry.

New connections keep credentials **in memory only** by default. Reloading retains your credential-free offline identity, music, and queue, but requires signing in again for server access. Select **Remember this device** only on a trusted device to save verified credentials in localStorage after the account workspace is accepted. Existing remembered credentials remain recognized until you disconnect or explicitly opt out; they are not silently deleted on startup. This choice controls Libras storage, not your browser’s password manager.

Remembered token login saves username/token/salt, not your password. Verified direct-password fallback saves the actual password and sends it with subsequent requests, including artwork and streaming URLs. HTTPS encrypts transport, not localStorage; same-origin scripts and anyone with access to your browser profile can read saved credentials. Disconnect removes credentials but retains offline identity/data unless you also choose local deletion.

## Install

You can use Libras in your browser or install it as a standalone web app:

- **iPhone/iPad:** Open in Safari, then choose **Share → Add to Home Screen**.
- **Android:** Choose **Install app / Add to home screen** from the browser menu.
- **Desktop:** Use the browser's install option, where available.

Installation options vary by browser and device. Offline storage and background playback have not yet been verified on iOS. Physical iPhone validation is **NOT PERFORMED / PENDING DEVICE ACCESS**; see the [Safari and installed-mode validation protocol](docs/iphone-validation.md).

## Listen offline

Download music while connected, then choose **Work offline** in navigation or Settings. This turns off all server access, stops remote playback and pauses requested downloads while retaining their queued intent. Cached playback can continue. Choose **Connect** to resume queued downloads; failed jobs require Retry. Reconnecting never loads or saves the server queue.

**Library scope → All music / Downloaded** is independent of the connection. Downloaded filters browsing and search without disconnecting or changing your queue, position or active audio. All music can browse saved metadata offline; uncached tracks remain visible as unavailable.

- **Manage downloads:** Downloads in navigation (also linked from Settings). Totals count registered completed audio bytes, not total browser storage. Remove individual formats, or confirm **Remove all downloaded music** for this account. Queue membership and server files stay unchanged; pending jobs use the separate Cancel downloads action. Removing an active cached source stops/unloads it. Catalog deletion must succeed before bytes are reclaimed; failures remain visible for retry.
- **Refresh library:** Automatic when opening online, or via Settings → Refresh library.
- **Disconnect:** Clears credentials and optionally deletes this account’s local cache and downloads. Remembered identity, preferences, other accounts and server data are unchanged. Only one tab can open an account’s local data at a time, including while deleting it. A second tab is blocked: close the owning tab, then select **Retry**. There is no automatic takeover or live cross-tab queue replication.
- **Storage:** Each server/account has its own offline library, saved only in this browser on this device. **Clearing site data deletes it.**

## App updates

An app-update button beside Settings appears when an update is ready. Open it and choose **Update now** to install it—this reloads the app and interrupts playback.

## Development

This is a pnpm workspace: the root `libras` package contains the app, and [`@libras/website`](website/README.md) contains the landing page and a standalone live demo at `/demo/` that imports it. Run the website with `pnpm --filter @libras/website dev`, then open `/demo/` for the player.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, checks, deployment, and storage architecture.

## License

[MIT](LICENSE) © 2026 Bogdan Chadkin.
