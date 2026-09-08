# Libras

Libras is a browser-based music player that connects to your own Navidrome server. Browse your library, play music, and download tracks to take with you.

> Named after “3 Libras” by A Perfect Circle.

**[Open Libras](https://trysound.github.io/libras/)**

## Features

- Browse artists, albums, and tracks.
- Stream music from your Navidrome server.
- Download music for offline playback and manage it in Settings → Downloads.
- Restore your playback queue and position between sessions.
- Install as a standalone web app.
- Choose when to apply app updates, without automatic playback interruptions.

## Get started

1. Open [Libras](https://trysound.github.io/libras/).
2. Connect to your Navidrome server with your server address and credentials.
3. Browse your library and start listening.

You'll need a reachable **HTTPS Navidrome server** configured to allow browser requests from `https://trysound.github.io` (CORS). Libras is a player, not a music hosting service; bring your own server and library.

## Install

You can use Libras in your browser or install it as a standalone web app:

- **iPhone/iPad:** Open in Safari, then choose **Share → Add to Home Screen**.
- **Android:** Choose **Install app / Add to home screen** from the browser menu.
- **Desktop:** Use the browser's install option, where available.

Installation options vary by browser and device. Offline storage and background playback have not yet been verified on iOS.

## Listen offline

Open Libras online first and download the music you want to keep. Use **Offline Library** mode to listen to downloaded tracks without a connection.

Downloads and saved app data live in your browser on that device. Clearing site data removes them, and they don't automatically transfer to another browser or app address.

When an update is available, a dot appears on the settings button. Open **Settings → Update now** when you're ready. The update stays available without a popup; applying it reloads the app and interrupts playback.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, checks, deployment, and storage architecture.

## License

[MIT](LICENSE) © 2026 Bogdan Chadkin.
