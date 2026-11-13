# Physical iPhone playback and recovery validation

**Result: NOT PERFORMED / PENDING DEVICE ACCESS.** No physical iPhone is available in the automated environment. Desktop Chromium or automated WebKit results do not establish iPhone background playback, lock-screen integration, or installed-mode behavior.

Run this protocol separately in Safari and Add to Home Screen installed mode, on the same tested HTTPS origin. Use a disposable account and retain sanitized observations; never include credentials or credential-bearing media URLs.

## Record

- Date/tester, device model, iOS build, Safari version, browser or installed mode.
- App commit/build, origin/base path, server/version and CORS setup.
- Raw audio codec/container and duration; transcoded format and server settings.
- For each step: PASS / FAIL / NOT RUN, actual behavior, timestamps, sanitized logs, and reproduction steps. Do not replace this pending result without device evidence.

## Protocol (both modes)

1. Connect to a reachable HTTPS/CORS-enabled server. Play supported raw audio, then a source requiring transcoding fallback. Verify pause, resume, seek forward/backward and track changes. Record any activation-required error and explicit Play retry.
2. Check Media Session title/artwork, lock-screen play/pause/next/previous, screen lock and background playback. Navigate within the app and return from another app; confirm queue/position and that audio is not duplicated.
3. Interrupt with a call/alarm/another audio app. Switch speaker/headphones/Bluetooth output, disconnect the output, then return to the foreground and retry explicitly if required. Record OS-specific pause/resume behavior rather than assuming automatic recovery.
4. Download music to completion. Choose Work offline and airplane mode. Play and seek cached audio, including after pausing/resuming. Confirm uncached queue entries remain visible/removable and unavailable, without silently rewriting the queue.
5. Pause at a known position, background/close and relaunch. Verify saved selection/position, **no autoplay**, then explicit Play offline. Repeat in installed mode. Distinguish normal relaunch from OS termination/eviction; storage and the last uncheckpointed edit are not guaranteed after eviction.
6. Interrupt an active queued download by Work offline, network loss, and app termination (separate trials). Reconnect explicitly. Queued jobs restart from scratch; failed jobs require Retry. Verify playable completed files, correct byte totals, and no phantom completed records or corrupt audio.
7. Lose the network during remote playback/load/seek. Verify honest failure/interruption and explicit recovery after reconnect. Confirm cached playback still works and reconnection never replaces the local queue. Test explicit Load/Save server queue separately; load must not autoplay.
8. With an update waiting, decline/dismiss first: no reload. Approve Update now: only this approving document reloads, route and durable local queue/position survive, playback does not autoplay. Repeat with an already-installed update while offline and a second unapproved tab.
9. Open the same account in another tab: activation is blocked. Close the owner, choose Retry, and verify local queue/resume. Disconnect without deletion: credentials disappear but offline music remains. Reconnect, cancel/Escape local removal, then confirm deletion: this account's bytes disappear and active cached audio unloads; other accounts/server data remain unchanged.

## Evidence and limitations

Attach one result table per mode and raw/transcoded source, with failures and unrun steps explicit. Include sanitized console/service-worker observations where available, output-device details, time spent backgrounded/locked, and any OS eviction or termination. A successful short run is not a guarantee of indefinite iOS background execution or durable storage retention.
