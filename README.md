# Navidrome Artists

A small client-only Svelte + Vite app that signs in to a Navidrome server and lists its artists through the Subsonic API.

## Run

```sh
pnpm install
pnpm dev
```

The Navidrome server must allow browser requests from the app's origin (CORS), and HTTPS should be used outside local development.

## Install on Android

The production app is installable as a standalone PWA. It includes regular and maskable icons and an offline app shell. Service workers are disabled in development to avoid interfering with hot reload.

Build and serve it on the machine containing the project:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4173 --strictPort
```

If the project runs on the phone itself (for example, in Termux), open `http://localhost:4173` in Chrome. If it runs on a remote SSH server, run this **on the phone** in an SSH client that supports local forwarding:

```sh
ssh -N -L 4173:127.0.0.1:4173 user@your-server
```

Keep the preview server and tunnel running, then open `http://localhost:4173` on the phone. Use Chrome's **Install app / Add to home screen** option and launch the installed app from the home screen. Localhost is a secure-context exception; a remote or LAN deployment needs HTTPS. Vite preview is for testing, not production hosting.

The Navidrome server must be reachable **from the phone** and permit the frontend origin through CORS. Switching ports or hosts creates a different origin: saved authentication and downloaded music do not carry over automatically.

## Offline behavior and updates

- The service worker precaches only the production app shell, manifest, and install icons. The style guide is not available offline.
- Subsonic API requests, artwork, and audio streams are not runtime-cached by the service worker. Metadata, artwork, and downloads remain owned by the existing engines.
- Metadata is a complete OPFS snapshot at `metadata/<account-hash>.json`, with normalized artist, album, and track arrays. Tracks reference artists and albums by ID; runtime maps provide lookups and sorted relationships. The snapshot restores at startup before network connection/revalidation, stays visible during refresh, and is replaced only after a complete validated save. No credentials are stored in it.
- The queue stores ordered track IDs independently of metadata. Playback resolves metadata on demand and ignores unknown IDs. Queue events remove those IDs and clear a missing selection's position without autoplaying another track; there is no separate metadata listener. Downloads retain independent track descriptions.
- The old IndexedDB metadata cache is no longer read or migrated. Connect online once to populate the new snapshot. Downloaded audio, artwork, and saved authentication are not removed.
- **Settings → Downloads** lists active downloads, queued tracks, and completed files newest-first. Downloads run with up to three concurrent transfers; playback seeks take priority over queued bulk downloads.
- Audio lives in OPFS under `tracks/`. The adjacent `downloads.json` is a validated list of completed file references, track metadata, account scope, format, size, and completion date; it contains neither credentials nor active/queued jobs. The engine loads it into a map, serializes catalog writes, and uses Web Locks where available to coordinate tabs.
- Existing hashed audio files are adopted into the catalog when matched against library metadata, retaining their file modification dates. Files that cannot be matched remain untouched. The saved catalog can be listed without reloading the music library; missing file references are removed when the catalog opens.
- First visit online so installation and shell caching can complete. Download music in the app before testing Offline Library mode.
- A new version shows **Update now / Later**. Nothing reloads automatically during playback; choosing Update now explicitly reloads the app and interrupts playback.
- Updates are checked when the app becomes visible and hourly while visible and online.

To test updates, leave the installed app open, change the app, run `pnpm build` again, then return to the app to trigger a check. Chrome DevTools' Application panel can inspect the manifest, service worker, and caches. Clear site data or unregister the worker when testing a completely fresh installation (clearing site data also deletes saved app data).
