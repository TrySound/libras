<p align="center">
  <img src="public/logo.svg" alt="Libras logo" width="120" height="120" />
</p>

<h1 align="center">Libras</h1>

Libras is a browser-based minimalistic music player that connects to your own music server. Browse your library, play music, and download tracks to take with you.

> Named after “3 Libras” by A Perfect Circle.

![Libras music player interface](website/public/screenshots/hero.webp)

## Features

- Browse artists, albums, and tracks.
- Stream music from your own server.
- Download music for offline playback and manage it in Settings → Downloads.
- Restore your playback queue and position between sessions.
- Install as a standalone web app.

## Get started

1. Open [Libras](https://libras-music.app/webapp/).
2. In Settings, enter your server address, choose **Check server**, then connect with your credentials.
3. Browse your library and start listening.

Just trying it out? Connect to the [Navidrome demo server](https://demo.navidrome.org/) using `https://demo.navidrome.org` as the server address and `demo` as both the username and password.

You'll need a reachable **HTTPS OpenSubsonic server**, such as [Navidrome](https://www.navidrome.org/), supporting empty-query `search3` for library synchronization and configured to allow browser requests from `https://libras-music.app` (CORS). Libras is a player, not a music hosting service; bring your own server and library.

### Authentication and security

Libras checks server capabilities without credentials and defaults to API key when advertised, otherwise username/password. You can explicitly switch between three methods:

- **API key (preferred):** Generate a key in your server's settings. Enter only the key; Libras validates it with `tokenInfo` and resolves your username for the account's existing offline library.
- **Username and password (MD5 token):** Derives a token/salt pair without saving the password.
- **Direct password (legacy):** Sends the password itself, always over HTTPS, only after a warning and your confirmation. Hex encoding is not encryption.

An explicitly unsupported discovery endpoint permits legacy login; network/CORS failures do not imply missing capabilities. Only an explicit MD5 rejection (Subsonic code `41` or `42`) offers a confirmed direct-password retry. Bad credentials, invalid API keys, timeouts, and other errors never silently downgrade authentication; switching methods requires the appropriate credentials.

All credentials, including API keys, replayable token/salt pairs, and direct passwords, are saved in `localStorage` on this device until disconnect; they are **not short-lived session tokens**. All browser storage is JavaScript-readable: malicious scripts or compromised browser access can steal these secrets. Use a trusted device and server. Existing saved token/salt credentials migrate without forcing logout.

API requests prefer form POST when the server advertises `formPost`, but artwork and streaming URLs still contain credentials. HTTPS protects transport, not server/proxy logs; avoid sharing media URLs and configure logs not to record credentials.

## Install

You can use Libras in your browser or install it as a standalone web app:

- **iPhone/iPad:** Open in Safari, then choose **Share → Add to Home Screen**.
- **Android:** Choose **Install app / Add to home screen** from the browser menu.
- **Desktop:** Use the browser's install option, where available.

Installation options vary by browser and device. Offline storage and background playback have not yet been verified on iOS.

## Listen offline

Download music while online, then switch to **Offline Library** to listen without a connection.

- **Manage downloads:** Settings → Downloads.
- **Refresh library:** Automatic when opening online, or via Settings → Refresh library.
- **Disconnect:** Clears saved credentials for every authentication method from `localStorage`, but keeps the account identity, saved music, and queue for offline use. Reconnect to leave offline mode; disconnect first to switch servers.
- **Storage:** Each server/account has its own offline library, saved only in this browser on this device. **Clearing site data deletes it.**

## App updates

An app-update button beside Settings appears when an update is ready. Open it and choose **Update now** to install it—this reloads the app and interrupts playback.

## Development

This is a pnpm workspace: the root `libras` package contains the app, and [`@libras/website`](website/README.md) contains the landing page and a standalone live demo at `/demo/` that imports it. Run the website with `pnpm --filter @libras/website dev`, then open `/demo/` for the player.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, checks, deployment, and storage architecture.

## License

[MIT](LICENSE) © 2026 Bogdan Chadkin.
