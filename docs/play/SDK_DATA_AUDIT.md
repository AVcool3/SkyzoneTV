# ParkCast Player — SDK & Third-Party Dependency Audit (Google Play)

Audit date: 2026-09-21. Sources read: `android-player/app/build.gradle.kts`,
`android-player/build.gradle.kts`, `android-player/settings.gradle.kts`,
`server/public/player/index.html`, `server/public/player/player.js`,
`server/public/player/birthday.js`, `server/public/dashboard/index.html`,
`server/public/dashboard/app.js`, `server/package.json`.

---

## 1. Android app Gradle dependencies (the complete list)

`android-player/app/build.gradle.kts:56-59` declares exactly two dependencies:

| Dependency | Version | What it is | Data collection verdict |
|-----------|---------|------------|------------------------|
| `androidx.appcompat:appcompat` | 1.7.0 | AndroidX base activity/theme compatibility (used for `AppCompatActivity`, MainActivity.kt:20, 29) | **None.** Google's AndroidX support library; no network stack, no analytics, no identifiers. Not on Google's Play SDK Index as a data-collecting SDK |
| `androidx.webkit:webkit` | 1.11.0 | AndroidX WebView compatibility APIs | **None.** Same as above. (Note: the system WebView itself is a platform component updated via Play — not an app dependency choice) |

Build plugins (`android-player/build.gradle.kts:2-3`): AGP 8.10.1 and Kotlin Android
2.0.20 — build-time only, ship no code that phones home. Repositories are limited to
`google()` + `mavenCentral()` with `FAIL_ON_PROJECT_REPOS` (settings.gradle.kts:8-13),
so no dependency can be silently pulled from an untrusted repo.

**There is no analytics SDK, no crash reporter, no ads SDK, no push SDK, no Google Play
Services / Firebase dependency of any kind.** Consequences worth stating on the record:

- No advertising ID is accessed; `com.google.android.gms.permission.AD_ID` is absent
  from the merged manifest (verified — see PERMISSION_AUDIT.md §4/§5).
- Data safety's "Does your app collect data via third-party SDKs?" dimension is a clean
  No.
- The trade-off: no crash telemetry either. Renderer crashes are self-healed on-device
  (`onRenderProcessGone` → `recreate()`, MainActivity.kt:89-94) and connection failures
  self-retry (MainActivity.kt:52-87) — nothing is reported anywhere.

## 2. What the player web page loads (the code the WebView actually runs)

`server/public/player/index.html` — full file reviewed (157 lines):

| Resource | Line | Origin | Verdict |
|----------|------|--------|---------|
| `/favicon.svg`, `/favicon.png` | index.html:7-8 | Same origin (the venue's server) | No third party |
| Inline `<style>` | index.html:9-124 | Inline | Uses only system font stacks — `'Segoe UI', Roboto, Arial, sans-serif` (index.html:16) and `'Arial Black', Impact, ...` (38, 97). **No Google Fonts, no font CDN, no `@import`, no external `url()`** |
| `birthday.js` | index.html:154 | Same origin | Pure canvas scene renderer; verified to contain zero network calls (no fetch/XHR/WebSocket/http URLs) |
| `player.js` | index.html:155 | Same origin | Talks only to its own origin: `fetch('/api/player/register')` (player.js:153), `WebSocket` to `location.host` (player.js:173), media loaded from relative URLs resolved against `location.href` (player.js:375, 431) |

**Verdict: the player page is fully self-hosted.** With the shipped default server, the
only network peer the TV ever contacts is `parkcast.onrender.com` (plus whatever server
the operator explicitly configures via the MENU dialog, MainActivity.kt:137-153). No
CDN, no fonts service, no analytics beacon, no third-party origin of any kind. One
caveat that is content, not code: an operator's *composed layout* can reference media
only by `mediaId`, which the server resolves to its own `/media/...` URL at push time
(server/src/index.js:194-203, 138) — so even operator designs cannot make the TV fetch
from arbitrary third-party URLs.

## 3. Dashboard vendored libraries — operator-side, NOT in the TV app

`server/public/dashboard/vendor/` contains two vendored (self-hosted, no CDN) libraries:

- `pptx-preview.umd.js` — renders PowerPoint slides in the operator's browser.
- `html2canvas.min.js` — rasterizes those slides to PNGs.

They are lazy-loaded **only by the dashboard** on first .pptx import
(`server/public/dashboard/app.js:1700-1701`, `loadScript('vendor/...')`) and referenced
nowhere in `server/public/player/` (verified by grep). The TV app never loads the
dashboard page; MainActivity always navigates to `/player/` (MainActivity.kt:133). These
libraries therefore have **zero bearing on the Play Data safety form** for ParkCast
Player. For completeness: both run entirely client-side in the operator's browser
(conversion happens locally; resulting PNGs are uploaded to the venue's own server), and
being vendored means the dashboard also makes no CDN requests for them.

The dashboard page itself (`server/public/dashboard/index.html`) also loads only
same-origin resources (style.css:10, app.js:437, favicons 7-9) — no external origins.

## 4. Server dependencies (context only — server is the operator's service, not the app)

`server/package.json:20-24`: `express`, `multer`, `ws`. All are request-handling
infrastructure with no telemetry. Listed because Play reviewers sometimes ask what the
backend is; not part of the app's SDK disclosure.

## 5. Summary for the Play listing

- Third-party SDKs in the app: **none** (two AndroidX libraries only).
- Third-party network endpoints contacted by the app: **none** (single-origin design).
- Data collected by SDKs: **none** — every byte that leaves the device is enumerated in
  PRIVACY_DATA_INVENTORY.md §3 and is first-party app code.
