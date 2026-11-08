# Player installation: evidence and acceptance limits (#97)

Installation is offered only in player Settings. Landing links still navigate to the player; the landing page stays script-free and the demo stays non-PWA. Browser installation, service-worker setup, and approval-gated updates are independent. Installation does not guarantee locked/background downloads, eviction-proof storage, or shared browser/installed-app data.

## Production audit: 2026-11-08

[Raw read-only production measurements](installation-audit/production-2026-11-08.txt) were supplied by the orchestration audit of `https://libras-music.app`, using Chromium **156.0.8078.4**, headless with a fresh persistent **non-incognito** profile. The deployed commit was not identified. These are observations of the deployed site, not a claim that the new Settings card was deployed.

| Surface | Manifest | Controlling worker | Trusted install event |
| --- | --- | --- | --- |
| `/` | None | None | None observed |
| `/demo/` | None | None | None observed |
| `/webapp/?/settings` | `/webapp/manifest.webmanifest` | `/webapp/sw.js` | Observed on fresh load and reload |

Player manifest `id`, `start_url`, and `scope` were all `/webapp/`, with `standalone` display. Chromium reported no player installability errors; landing/demo reported `no-manifest`. PNG icons returned HTTP 200 with dimensions 192×192, 512×512, and maskable 512×512; Apple touch icon was 180×180. After the player visit, landing/demo could enumerate its same-origin registration but remained uncontrolled. **Registration enumeration is not worker control.** Offline navigation to player Settings rendered the app shell in a browser tab.

### Audit method

Use external Playwright, the full Chromium executable (`executablePath: chromium.executablePath()`), `launchPersistentContext` with a fresh profile, and production HTTPS. Incognito or the default headless-shell executable can yield different eligibility results. Attach a context init script **before navigation** that records `beforeinstallprompt` (`isTrusted`, URL, platforms, timestamp), calls `preventDefault()`, and records `appinstalled`. Do not dispatch an event or call `prompt()` for the eligibility audit.

1. Visit landing, demo, then player, waiting for page readiness and 20 seconds on each.
2. Record manifest/icon links, `isSecureContext`, display-mode/Safari standalone signals, `navigator.serviceWorker.controller`, and `getRegistrations()` scopes and worker URLs.
3. Through a CDP session, record `Page.getAppManifest` and `Page.getInstallabilityErrors`.
4. Reload player and repeat. Fetch manifest icons and decode each with `createImageBitmap` to measure actual dimensions.
5. Set the browser context offline and navigate to `/webapp/?/settings`; record the rendered route and controller. Restore connectivity, revisit landing/demo, and distinguish enumerated registrations from controlling workers.

No native prompt was invoked during this production audit. No site writes or deployment occurred.

## Implementation validation

The player entry creates its controller before awaited polyfills; the player wrapper owns cleanup, while Settings only renders the card. No installation claim is persisted. A retained offer is consumed synchronously on activation, once per document; acceptance is not installation evidence. Dismissal does not reoffer until a new document. `appinstalled` and standalone evidence override pending results. Missing eligibility never creates a fake install button. Manual instructions remain available through native details on every device.

Automated coverage includes early capture during delayed startup, Settings-like unmount/remount, one-use prompting, duplicate activation, acceptance/dismissal/failure, evidence precedence, cleanup/late results, focus recovery, and demo exclusion. Existing updater and artifact-policy regressions remain in the normal suite.

Local validation used the combined production build at `/webapp/`, assembled outside the checkout as described in [website deployment instructions](../website/README.md#pages-deployment). All exited 0:

- `pnpm check`
- `pnpm test` (54 files, 1095 tests)
- `BASE_PATH=/webapp/ pnpm build`
- `pnpm --filter @libras/website build`
- `node website/verify-build.mjs --root <external-combined-directory>` (2.5 MiB)

Rendered checks used a fresh persistent full Chromium profile on loopback (a secure-context exception, **not production HTTPS**). The built player received a trusted install event, displayed its eligible action, and retained the offer across Settings → Library → Settings. Demo Settings had neither install card nor manifest nor controller. Open instructions were inspected at 320px, 390px, 768px, 1440px, and 390px with root text enlarged to 200%; no horizontal document overflow or browser console warnings/errors/page exceptions were recorded. A synthetic dismissal verified one invocation and keyboard focus recovery to the instructions summary. Synthetic outcomes validate app behavior only, not native eligibility or OS installation.

## Remaining manual acceptance checklist

These checks are **not completed** by unit tests, headless eligibility observation, or offline browser-tab navigation:

- [ ] On combined HTTPS deployment in an interactive normal-profile Chromium, invoke the genuine prompt by keyboard and pointer; verify native accept and dismiss, no repeated same-document offer, and truthful acceptance wording until installation evidence arrives.
- [ ] Launch from the actual OS-installed icon: verify `/webapp/` destination/scope, standalone state, and offline **cold** app-shell launch. Check unavailable and already-running cases.
- [ ] On a physical iPhone, follow Safari Share → Add to Home Screen; enable Open as Web App if shown. Verify menu/layout and Edit Actions guidance against the actual iOS release, intended player icon launch, standalone state, and offline cold launch. Check embedded/other-browser fallback without assuming all other browsers are unsupported. Reference: [Apple’s iPhone guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).
- [ ] Check screen-reader status announcements and native prompt return focus on real supported devices.
- [ ] Deploy a genuine update: verify approval-gated reload, playback warning, retry/timeout behavior, and query-route preservation while installation UX is present.

Do not mark physical-iPhone installation or installed offline launch accepted until those device checks are recorded. Keep download-reliability work (#96) separate.
