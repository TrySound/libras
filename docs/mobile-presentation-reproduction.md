# Mobile presentation reproduction — issue #93

Status: **awaiting physical-device reproduction; no root cause or fix established**.
This worksheet tracks [#93](https://github.com/TrySound/libras/issues/93), not acceptance completion. Production CSS is unchanged. Record the failing baseline before selecting a correction, then repeat the same cases on the candidate build.

## Evidence record

Copy this record for each device, mode, build and failing case. Use `not tested`, `not reproduced`, `fail` or `pass` explicitly; an empty cell is not a pass.

- Case ID and date:
- Device/model (physical or emulated):
- OS version/build:
- Browser version/build:
- App commit and deployed URL (omit credentials/private hostnames):
- Mode: browser tab / installed app (include installation method when relevant):
- Viewport/orientation and text size:
- Reduced motion: on / off:
- Preconditions, route, test artwork and exact steps:
- Expected / observed result:
- Affected layer or interactive target (unknown until demonstrated):
- Sanitized before screenshot/video and timestamps:
- Candidate commit, identical retest steps and sanitized after evidence:
- Result and remaining limitations:

Use a demo/test library. Remove server URLs, credentials, account names and private library metadata from shared captures; retain the visual defect and relevant browser chrome. Never attach credential-bearing network traces.

## M1 — physical Safari backgrounds

Run on **physical iPhone Safari and macOS Safari**. Record tab mode; repeat installed mode when relevant, or explicitly state it was not tested/not applicable. Repeat with reduced motion enabled. Record actual unsupported-effect fallback behavior on an affected browser; disabling declarations in DevTools is only an isolation experiment, not fallback acceptance.

For each surface below, capture initial render, slow and fast long scrolling, both native overscroll boundaries, and artwork loading where applicable. On iPhone, expand/collapse dynamic toolbars. Open/close Now Playing from the page and verify the page's background and scroll position afterward. Repeat dialog entry/exit and long dialog scrolling.

| Surface | Particular checks | iPhone result/evidence | macOS result/evidence |
| --- | --- | --- | --- |
| Library | Artwork-free background, long document | Not tested | Not tested |
| Artist | Header artwork loading, album tiles, long document | Not tested | Not tested |
| Album | Header artwork loading, long track list | Not tested | Not tested |
| Downloads | Empty and populated document | Not tested | Not tested |
| Settings | Long document, controls and overlays | Not tested | Not tested |
| Now Playing | Artwork loading, native dialog scroll, entry/exit | Not tested | Not tested |

Expected: no blank gaps, opaque blocks or exposed clipped edges; legible static decoration when animation/effects are unavailable or reduced motion is requested. The document remains the page scroll owner, Now Playing remains a native scrolling dialog, and native page overscroll remains available.

Inspection leads, **not diagnoses**: `src/ui/atmosphere.svelte` owns artwork and per-instance SVG displacement filters; `src/edgerunner.css` owns blur, masks, line decoration, clipping/stacking and optional scroll timelines. Capture the original failure first. If a controlled layer isolation helps, record each single change and its result separately; do not treat a successful workaround as proof of root cause.

## M2 — physical Android Chrome touch feedback

Record a held press and release on representative targets below, including artwork and text portions of compound targets. Note exactly where native blue feedback appears and whether intentional pressed feedback is visible. Compare the same target before/after any correction.

| Target family | Examples to exercise | Result/evidence |
| --- | --- | --- |
| Links and tiles | Navigation, library artist tiles, artist album tiles | Not tested |
| Tracks | Album/queue track targets and their separate action controls | Not tested |
| Menus | Invokers and menu items, including link items | Not tested |
| Controls | Primary/quiet/icon buttons, playback, seek, Settings controls | Not tested |
| Shared landing controls | Header/footer links, brand link, CTA buttons, text links, FAQ summaries | Not tested |

Expected: no unwanted native blue flash on affected targets **and** visible intentional pressed feedback. Test long press, selection/context-menu behavior and swipe dismissal where supported. With a hardware keyboard, verify Tab focus visibility and appropriate Enter/Space activation (links use Enter; buttons use Enter/Space). Record accessible names, touch-target usability, enlarged text, narrow/wide layouts and reduced motion. Recheck M1 after shared-style changes and M2 after background changes.

## Available automated evidence and limitations

The preparation run has no supplied physical recordings, affected OS/browser versions or configured physical-device session. All physical matrix entries above remain **not tested**; do not mark #93 complete on this evidence.

`tests/browser/atmosphere.test.cjs` checks Chromium geometry and CSS-only scroll depth in document/dialog fixtures. It also checks loaded artwork and lines remain visible, unanimated and geometrically covering the viewport while scrolling with reduced motion. The synthetic fixture omits the production SVG displacement filter: these are not pixel/compositor assertions, real-component rendering checks, or unsupported-browser fallback evidence.

Use the existing `navigation`, `quiet-button`, `edgerunner` and `website-cascade` browser suites as additional regression leads; see `CONTRIBUTING.md` for server/Playwright setup. Mouse-down in mobile emulation is not physical Android touch feedback. Desktop WebKit/Chromium automation does not close the Safari toolbar/overscroll/paint or physical-touch gates.

### Preparation validation

On Linux with Node 26.7.0, pnpm 11.25.0, Playwright 1.64.1 and headless Chromium 156.0.8078.4 (baseline app commit `e0af258`):

- `pnpm check`: pass, no errors/warnings in either package.
- `pnpm test`: 51 files / 1,041 tests pass.
- App and website production builds: pass.
- New document/dialog reduced-motion cases: both pass.
- Existing atmosphere document parallax case: pass. Existing dialog parallax case: **fails** the artwork 15%-speed assertion, also reproduced using the unmodified baseline test. No physical Safari conclusion follows from this Chromium failure.
- Quiet-button, navigation and edgerunner suites: 18 tests pass (including nested cases), against the app dev server where needed.
- Website-cascade suite: 5 tests pass against the built website preview.

Next step: obtain completed physical baseline records and sanitized captures, identify the affected layer/targets, choose the smallest supported correction, then attach matching physical after-results and regression results. Keep #93 open until its acceptance criteria are met.
