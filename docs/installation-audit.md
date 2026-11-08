# Player installation: evidence and acceptance limits (#97)

Installation is offered from the landing page when the browser supplies an eligible event, and from player Settings. The approved narrow exception to the former script-free/no-manifest landing policy is a minimal vanilla installation entry and an exact reference to the **player’s** `/webapp/manifest.webmanifest`. Static Install and persistent instructions links navigate to player Settings; iPhone manual installation must begin on that player URL, not the marketing root. There is no root worker, separate marketing-app identity, or scope expansion. The demo stays non-PWA. Browser installation, service-worker setup, and approval-gated updates are independent. Installation does not guarantee locked/background downloads, eviction-proof storage, or shared browser/installed-app data.

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

## Original player implementation validation

The player entry creates its controller before awaited polyfills; the player wrapper owns cleanup, while Settings only renders the card. No installation claim is persisted. A retained offer is consumed synchronously on activation, once per document; acceptance is not installation evidence. Dismissal does not reoffer until a new document. `appinstalled` and standalone evidence override pending results. Missing eligibility never creates a fake install button. Manual instructions remain available through native details on every device.

Automated coverage includes early capture during delayed startup, Settings-like unmount/remount, one-use prompting, duplicate activation, acceptance/dismissal/failure, evidence precedence, cleanup/late results, focus recovery, and demo exclusion. Existing updater and artifact-policy regressions remain in the normal suite.

Local validation used the combined production build at `/webapp/`, assembled outside the checkout as described in [website deployment instructions](../website/README.md#pages-deployment). All exited 0:

- `pnpm check`
- `pnpm test` (54 files, 1095 tests)
- `BASE_PATH=/webapp/ pnpm build`
- `pnpm --filter @libras/website build`
- `node website/verify-build.mjs --root <external-combined-directory>` (2.5 MiB)

Rendered checks used a fresh persistent full Chromium profile on loopback (a secure-context exception, **not production HTTPS**). The built player received a trusted install event, displayed its eligible action, and retained the offer across Settings → Library → Settings. Demo Settings had neither install card nor manifest nor controller. Open instructions were inspected at 320px, 390px, 768px, 1440px, and 390px with root text enlarged to 200%; no horizontal document overflow or browser console warnings/errors/page exceptions were recorded. A synthetic dismissal verified one invocation and keyboard focus recovery to the instructions summary. Synthetic outcomes validate app behavior only, not native eligibility or OS installation.

## Landing follow-up: local evidence, 2026-11-08

The historical production audit above predates the approved landing exception; it does **not** measure the new landing integration. Two separate local measurements informed and validated the change:

1. [Manifest-only experiment](installation-audit/landing-manifest-probe-2026-11-08.txt): a fresh persistent full Chromium 156 profile visited a root fixture on `http://127.0.0.1:5198/` with only the player manifest reference added. A trusted root `beforeinstallprompt` was observed, with no controller or registrations and no installability errors. No prompt was called. This was a loopback secure-context experiment, not production HTTPS.
2. [Actual built integration results](installation-audit/landing-built-local-2026-11-08.json): a fresh persistent **full** Chromium **156.0.8078.4** profile visited `http://127.0.0.1:5197/` before visiting the player. The root received a trusted event and both actual built CTAs became buttons. Root controller was null and registrations were empty. CDP returned the player manifest with `/webapp/` identity, start URL, and scope and no installability errors. All three player manifest icons decoded at their declared 192/512/512 dimensions. Demo remained manifest-free and uncontrolled; the player subsequently acquired `/webapp/sw.js` control with `/webapp/` registration scope.

The integration audit used external Playwright with `launchPersistentContext`, `executablePath: chromium.executablePath()`, a fresh profile, and an init listener recording event trust and location. It inspected `Page.getAppManifest`, `Page.getInstallabilityErrors`, worker control/registrations, and fetched/decoded icons, following the method above. Genuine eligibility was observed without invoking its native prompt. No root worker was registered to force eligibility.

Rendered checks covered eligible root and no-JavaScript layouts at 320px, phone/tablet/desktop widths and 200% root text, including both CTA groups. Header Launch had exactly one text line geometrically, and content bounds fit without depending on overflow clipping. No console warnings/errors or page exceptions were recorded. Both static anchors navigated with JavaScript disabled; with only the landing entry blocked, each destination started the player and scrolled its `#install-title` heading into the viewport. This verifies navigation/fragment startup, not a JavaScript-free player.

Separately labeled **synthetic** browser scenarios exercised pending, dismissed, accepted, failed, browser-reported installed, and standalone presentations from **each** CTA. They verified synchronous one-use invocation, a shared duplicate guard, dismissal/reoffer suppression, same-position keyboard focus replacement, persistent instructions links, and one live status region. Screenshots explicitly waited for the intended status before capturing each CTA group. Longer post-attempt instructions labels were also checked at 320px and 200% text. These scenarios validate app behavior only; synthetic events do not establish eligibility or native installation.

The combined production builds and artifact verifier passed after this follow-up. The verifier allows only the exact player manifest and named landing-install module entry, and still rejects demo manifest declarations, arbitrary/additional landing scripts, root/demo PWA artifacts, changed player identity/scope, and legacy catalog exports. The optional `website-cascade.test.cjs` suite covers no-JavaScript layout/navigation and shared install/focus behavior; unit tests cover outcomes, evidence precedence, and cleanup. Player Settings and updater behavior were not changed.

**Limits:** neither loopback measurement is new production-HTTPS evidence. No native prompt outcome, OS installation, physical-iPhone result, or installed cold/offline launch is claimed. Validate the deployed landing enhancement and device behavior before completing the checklist below.

## Remaining manual acceptance checklist

These checks are **not completed** by unit tests, headless eligibility observation, or offline browser-tab navigation:

- [ ] On combined HTTPS deployment, visit landing first in a fresh normal profile and recheck trusted eligibility, unchanged player manifest identity/scope, and absence of root worker control. Then, in interactive Chromium, invoke the genuine prompt from both landing CTA positions and player Settings by keyboard and pointer; verify native accept and dismiss, no repeated same-document offer, and truthful acceptance wording until installation evidence arrives.
- [ ] Launch from the actual OS-installed icon: verify `/webapp/` destination/scope, standalone state, and offline **cold** app-shell launch. Check unavailable and already-running cases.
- [ ] On a physical iPhone, follow Safari Share → Add to Home Screen; enable Open as Web App if shown. Verify menu/layout and Edit Actions guidance against the actual iOS release, intended player icon launch, standalone state, and offline cold launch. Check embedded/other-browser fallback without assuming all other browsers are unsupported. Reference: [Apple’s iPhone guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).
- [ ] Check screen-reader status announcements and native prompt return focus on real supported devices.
- [ ] Deploy a genuine update: verify approval-gated reload, playback warning, retry/timeout behavior, and query-route preservation while installation UX is present.

Do not mark physical-iPhone installation or installed offline launch accepted until those device checks are recorded. Keep download-reliability work (#96) separate.
