# Android TV Manual Test Plan — ParkCast Player

**App:** `com.parkcast.player` v1.3 (versionCode 5) · WebView kiosk loading `server/public/player/`
**Plan date:** 2026-09-21 · Target: Google Play 2026 TV requirements (TV Ready / Tier 3)
**Expected behaviors below are derived from the actual code** (`MainActivity.kt`, `BootReceiver.kt`, `player.js`, `index.html`, `birthday.js`) — a deviation from an "Expected" is a real bug, not a plan error.

## 0. Severity classification guidance

Apply these consistently when logging results:

- **BLOCKER** — would fail Play TV review or bricks the core use ("screen shows content unattended"): crash on launch; not installable/visible on a TV; no way to leave the app with the remote (BACK trap with no exit path); black screen or raw error page persisting > 60 s in any reachable state; banner missing/unreadable in the launcher.
- **HIGH** — a shipped feature is unreachable or wrong on standard TV hardware, or unattended recovery fails: server-address dialog cannot be opened or completed with a standard remote; no auto-recovery after network/server outage; playback permanently stops after sleep/wake; boot auto-start silently broken where the permission was granted.
- **MEDIUM** — degraded but self-recovering or cosmetic-with-impact: recovery takes far longer than designed backoff; text clipped by overscan; blurry banner/icon; state flicker on playlist pushes; transient wrong screen (< 30 s).
- **LOW** — cosmetic, edge-case, or operator-only: netdot invisible on an overscanning panel; hint text untranslated; log noise; minor animation jank at 4K.

## 1. Device / resolution matrix

Run the full plan on at least the first two; run §4, §6, §8 on all:

| Device | Why |
|---|---|
| Chromecast with Google TV (4K) — Android TV 12+, **remote without MENU button** | The reference Play-review device; exposes the MENU-only dialog issue and BAL/overlay behavior on 12+. |
| Google TV OEM panel (Sony/TCL/Hisense), 4K | Real-panel overscan, ambient mode/screensaver interaction, HDMI-CEC. |
| Android TV 9 or 10 box, 1080p | Oldest common Play-certified fleet hardware. |
| ADT-3 / Android TV emulator, 720p profile | 720p layout + smallest WebView viewport. |
| (Out of Play scope, still fleet-relevant) Fire TV Stick 2nd gen, Fire OS 5 = API 22 | minSdk floor: verifies the `SDK_INT < M` overlay-permission skip paths (`MainActivity.kt:111`, `BootReceiver.kt:19`). |

Resolutions: every visual check in §5–§7 is repeated at **720p, 1080p, 4K** (set via device display settings or emulator profiles). All player text is `vmin`/`vh`-based (`index.html:30-123`), so relative size must be identical across resolutions — any absolute-pixel-looking text is a bug.

## 2. Install, first launch, pairing

| # | Steps | Expected | Fail severity |
|---|---|---|---|
| 2.1 | Install the release AAB via Play internal testing on a Google TV device. Open the launcher's app row. | App appears in the TV launcher with the 320×180 banner: "PARKCAST / VENUE SCREEN PLAYER" wordmark, legible at 10 ft, not stretched or soft. | BLOCKER if absent from launcher; MEDIUM if soft/blurry (banner is in density-unqualified `drawable/`) |
| 2.2 | Launch from the banner. | Fullscreen black immediately (theme `themes.xml:3-6`), then the branded idle screen: "PARKCAST" logo + "Connecting…" (`player.js:543-544`), then the pairing code (`Code XXXX`, `player.js:267-276`) once registered. No status bar, no navigation bar, no white flash. | BLOCKER (crash/white page); HIGH (stock error page visible) |
| 2.3 | First launch only: the boot-permission dialog appears ("Allow auto-start after power loss", `MainActivity.kt:115-126`). Navigate with D-pad only. | Both buttons focusable and activatable with D-pad; "Open setting" opens the Display-over-other-apps screen (or fails silently if the Settings intent doesn't resolve — no crash, `MainActivity.kt:119-123`); "Later" dismisses. Dialog appears **once ever** — relaunch and confirm it does not return (`bootPermAsked`, `MainActivity.kt:113-114`). | HIGH (not D-pad operable); MEDIUM (re-appears on later launches — kiosk nag) |
| 2.4 | Pair the code in the dashboard ("+ Add screen"). | TV leaves the pairing screen on the next state push and shows the assigned content or the quiet idle screen (logo + TV name, hint cleared — `player.js:278`). | HIGH |
| 2.5 | Upgrade path: install versionCode 4 build (if archived), pair, then update to 5. | TV identity survives (localStorage `parkcast.tvId`, migration from `skyzone.tvId` — `player.js:26-29`); no re-pairing needed. | HIGH for fleet, not a Play item |

## 3. D-pad and remote operability

| # | Steps | Expected | Fail severity |
|---|---|---|---|
| 3.1 | On the main player screen press all D-pad directions, SELECT, PLAY/PAUSE. | Nothing visibly reacts (display-only kiosk); no focus highlight, no WebView scroll, no crash. Media keys must not pause the signage loop. | MEDIUM |
| 3.2 | Press MENU on a remote that has it (or `adb shell input keyevent 82`). | Server-address dialog opens (`MainActivity.kt:156-159`) with the current URL pre-filled (`MainActivity.kt:141`). | HIGH |
| 3.3 | **On a Chromecast-with-Google-TV remote (no MENU button), attempt to open the server dialog without adb.** | Currently impossible — this is the documented HIGH finding. When the long-press-SELECT (or equivalent) alternative lands, verify it here. | HIGH |
| 3.4 | In the URL dialog: D-pad to the EditText, press SELECT. | TV on-screen keyboard (Gboard TV) opens; URL can be typed and committed with D-pad only; focus then moves to Connect/dialog buttons. | HIGH |
| 3.5 | In the URL dialog press BACK. | Dialog dismisses (it is cancelable — `serverUrl` is always seeded, `MainActivity.kt:100-102,147`); the app does **not** exit; playback continues underneath. | MEDIUM |
| 3.6 | Enter a host with no scheme (e.g. `192.168.1.50:8080`) and Connect. | App normalizes to `http://192.168.1.50:8080/player/` (`playerUrl()`, `MainActivity.kt:129-135`) and loads it. | MEDIUM |
| 3.7 | Enter an unreachable address and Connect. | Branded "PARKCAST / Connecting…" screen (never the stock WebView error page) with a retry every 5 s (`MainActivity.kt:52-76`). Recover by re-opening the dialog and restoring the good address. | HIGH if stock error page appears |

## 4. BACK behavior (kiosk exit)

| # | Steps | Expected (current build) | Expected (after guarded-exit change) | Fail severity |
|---|---|---|---|---|
| 4.1 | Press BACK once during playback. | Consumed, nothing happens (`MainActivity.kt:161`). | Same. | — |
| 4.2 | Press BACK repeatedly (5+ times, quickly). | Consumed — **this is the state that fails TV Ready** ("repeated BACK returns to TV home"). | Exit confirmation appears on the 3rd press within ~2 s; default focus "Keep playing"; "Exit" leaves to the TV home screen. | **BLOCKER** for Play review until the change lands |
| 4.3 | Press HOME. | Always returns to the TV launcher (cannot be intercepted); app goes to `onPause` → `webView.onPause()` (`MainActivity.kt:187-190`). | Same. | BLOCKER if not |
| 4.4 | Relaunch from launcher after HOME. | Player resumes; WebSocket reconnects if it dropped (`player.js:205-213`); correct current state within ~15 s (max backoff, `player.js:212`). | Same. | HIGH |

## 5. Web player visual/TV-layout checks (repeat at 720p/1080p/4K)

| # | Steps | Expected | Fail severity |
|---|---|---|---|
| 5.1 | Idle/pairing screen at 10 ft. | Logo ~8 vmin, pairing name/code ~6 vmin, hint ~2.6 vmin (≈28 px @1080p), conn line ~2.2 vmin (`index.html:52-59`) — all legible at 10 ft; hint constrained to 70% width; nothing touches screen edges. | MEDIUM |
| 5.2 | Overscan: enable panel overscan (or a TV that overscans by default). | All *text* states (idle, pairing, slides with 6 vmin padding `index.html:31`, birthday text with 7 vh top padding `index.html:94`) keep text inside the visible area — content is centered, so the ~5% overscan crop must not touch it. Full-bleed media (video/image layers, `index.html:18-24`) may crop — acceptable by design. The red netdot sits 1.2 vmin from the corner (`index.html:119-123`) and may be cropped — LOW, diagnostic only. | MEDIUM (text cropped); LOW (netdot) |
| 5.3 | Inspect every reachable screen for interactive affordances. | None exist: no buttons/links/tabindex in `index.html`/`player.js`/`birthday.js` (verified — only `resize` and `visibilitychange` listeners); no focus ring ever visible; `cursor: none` (`index.html:15`). | MEDIUM |
| 5.4 | Review all on-screen strings (player + Android dialogs). | No touch-language ("tap/swipe/touch/click") anywhere — verified by grep across `server/public/player/` and `res/values/strings.xml`; keep it that way when editing copy. Dialog copy says "Press MENU"-style remote language only. | MEDIUM |
| 5.5 | Raw-error audit: with adb logcat open, walk §6–§8. | At no point does the TV render a stack trace, raw JSON, `net::ERR_*` page, or "Aw, Snap": network errors → branded connecting screen (`MainActivity.kt:52-87`); bad register JSON → retry loop message (`player.js:546-552`); all-media-failed → operator message "Assigned media failed to play…" (`player.js:408-425`) which is intentional and acceptable. | BLOCKER (stock error/stack on a public screen) |
| 5.6 | Playlist rendering: assign video + image + slide + design ("comp") items, transitions none and fade. | Instant swaps (or 0.7 s crossfade, `index.html:26`), preload via standby slot (`player.js:427-438`), no black gap between items, slides crisp at 4K (DOM-rendered, `player.js:59-141`). | MEDIUM |
| 5.7 | Birthday override: trigger a test event, each theme, with and without media video. | Takeover < 2 s; letter-pop headline; confetti canvas full-screen; broken media video falls back to comic background (`player.js:500-503`); ends on time even with the server connection killed mid-event (local `overrideTimer` fallback, `player.js:519-528`). | HIGH (stuck birthday screen) |
| 5.8 | Power off from dashboard. | Pure black screen (`#off`, `index.html:63-64`), status reports "Screen off" (`player.js:220`); power on restores the playlist without reload. | MEDIUM |

## 6. Network and server failure (stability matrix)

Precondition: paired TV, playlist assigned. Keep a stopwatch; backoff is 1 s → ×1.7 → cap 15 s with jitter, reset only after 30 s of stable connection (`player.js:174-183, 211-212`).

| # | Scenario | Steps | Expected | Fail severity |
|---|---|---|---|---|
| 6.1 | WS drop, server alive | Kill just the WebSocket (server restart < 5 s). | Playback continues uninterrupted from local state; red netdot appears (`player.js:207`); reconnect within ~15 s; netdot clears. | HIGH |
| 6.2 | Network flap | Pull Ethernet/Wi-Fi 30 s, restore. | Current playlist keeps looping (media may stall if streamed; local loop of cached items continues); idle screen only if it was already idle; on restore, reconnect ≤ 15 s + jitter. No reload of the page, no pairing-code regression. | HIGH |
| 6.3 | Long outage | Network off 30 min. | Backoff stays capped at 15 s (no stampede, no give-up); "Reconnecting to server…" visible only on the idle screen (`player.js:208-209`); recovers unattended on restore. | HIGH |
| 6.4 | Server 5xx | Make the server return 503 for `/player/` then relaunch the app (main-frame HTTP error path, `MainActivity.kt:78-87`). | Branded connecting screen + 5 s retry loop; auto-recovers when the server is healthy. Repeat with 404. | HIGH |
| 6.5 | Server hang (accepts TCP, never responds) | Simulate with a firewalled/hung port, cold-launch. | Currently: black screen until WebView's own timeout fires `onReceivedError` (can be > 60 s). Watch and time it — if > 60 s of black, log as the known watchdog gap (see audit change list). | MEDIUM (self-resolves) / HIGH if it never errors |
| 6.6 | Crash-looping server | Restart the server every 10 s for 3 min with 2+ TVs. | Fleet keeps backing off (stable-timer prevents backoff reset, `player.js:180-183`); jitter desynchronizes reconnects (`player.js:211`). | MEDIUM |
| 6.7 | Broken media | Assign a playlist where one item 404s; then where **all** items are broken. | One bad item: skipped after ~1.5 s (`player.js:424`), loop continues, no double-count (`failOnce`, `player.js:388-399`). All bad: idle screen + "Assigned media failed to play… Retrying…" and a 30 s retry (`player.js:408-425`) — never a silent black loop. | HIGH |
| 6.8 | Expired/revoked pairing | Delete the TV in the dashboard (server sends `reregister`), and separately: wipe server DB. | TV clears its stored id (`player.js:191-203`), re-registers, shows a **new pairing code** — no stuck "unapproved" limbo, no reboot needed. If registration fails mid-flow, it retries every 5 s. | HIGH |

## 7. Lifecycle, sleep/wake, process death

| # | Scenario | Steps | Expected | Fail severity |
|---|---|---|---|---|
| 7.1 | TV sleep/wake (remote power) | Sleep 2 min via remote, wake. | On sleep: `onPause` → `webView.onPause()` pauses JS timers/video (`MainActivity.kt:187-190`). On wake: `onResume` → `webView.onResume()` (`182-185`), `visibilitychange` re-requests wake lock (`player.js:539`), WS reconnects if dropped, correct state ≤ 15 s. No black screen, no frozen frame > 30 s. | HIGH |
| 7.2 | Long standby | Sleep overnight (8 h+), wake. | Same as 7.1. If the OS killed the process: relaunch from launcher restores full state from server (nothing critical is only in RAM — id is in localStorage). | HIGH |
| 7.3 | Screensaver/ambient | Leave playing 4 h+ with device screensaver at default timeout. | `FLAG_KEEP_SCREEN_ON` (`MainActivity.kt:37`) must prevent screensaver/ambient mode while playing. MANUAL VERIFICATION per OEM. | HIGH for signage |
| 7.4 | Process kill | `adb shell am kill com.parkcast.player` (background it first), relaunch; also `am force-stop` + boot test. | Clean relaunch to correct state. Note: after force-stop, `BOOT_COMPLETED` will not be delivered until manual launch (Android rule) — expected, document for installers. | MEDIUM |
| 7.5 | Renderer crash | `adb shell kill -9 <webview renderer pid>` (or load `chrome://crash` variant via a test page). | `onRenderProcessGone` returns true and `recreate()`s the activity (`MainActivity.kt:89-94`) — brief black, then full reload; **no** "Aw, Snap", no dead white screen, no app crash dialog. Repeat 3× consecutively. | BLOCKER (crash dialog on public screen) |
| 7.6 | Boot auto-start | Grant overlay permission, power-cycle the device (mains, not remote-standby). | Player is frontmost within ~2 min of the launcher appearing (`BootReceiver.kt:15-24`). Repeat **without** the permission: no crash, no start (silent skip, `BootReceiver.kt:19-20`) — installers must know Later = no autostart. Verify specifically on Android TV 12+ where background-activity-launch rules are strictest. | HIGH |
| 7.7 | Config/HDMI events | Switch HDMI input away/back; change display resolution while playing. | No activity recreation for size/orientation (`configChanges`, `AndroidManifest.xml:25`); player continues; vmin layout reflows correctly after resolution change (`birthday.js:530` resize handler for canvas). | MEDIUM |

## 8. Soak tests (signage duty cycle)

Log: `adb shell dumpsys meminfo com.parkcast.player` every 30 min; screen photo per hour; logcat to file.

| # | Duration | Content | Pass criteria | Fail severity |
|---|---|---|---|---|
| 8.1 | 1 h | Mixed playlist (2 videos, 2 images, 1 slide, 1 comp), fade transitions. | Zero visible stalls; loop timing correct (image `durationSec` honored, `player.js:363,372`); memory growth < 20% after warm-up plateau. | HIGH |
| 8.2 | 8 h | Same playlist + one birthday override per hour (scheduled). | No renderer crash (or if one occurs, invisible-recovery per 7.5 within 10 s); overrides start and end on schedule; memory plateau stable. | HIGH |
| 8.3 | 24 h | Production-like: playlist + overnight `power off` window + morning power-on + at least one forced network flap. | Screen correct at every hourly photo; no interaction needed at any point in 24 h; wake-from-power-off shows playlist ≤ 15 s. This is the release gate for the fleet. | BLOCKER for fleet release (not a Play item) |
| 8.4 | During 8.2 | Push playlist edits from the dashboard every ~30 min. | Same-playlist pushes never restart the current item (`playlistKey` check, `player.js:301-306`); a busy dashboard cannot freeze one image on screen (timer kept, `player.js:324-327`). | MEDIUM |

## 9. Pre-submission checklist (Play Console)

- [ ] `leanback required="true"` landed (TV-only) and the bundle was re-reviewed for phone-form-factor removal.
- [ ] BACK guarded-exit landed; §4.2 passes on a Chromecast remote.
- [ ] Server-dialog alternative trigger landed; §3.3 passes without adb.
- [ ] Store listing has TV screenshots (16:9, from a real device at 1080p+) and the 1280×720 TV banner asset; in-APK banner verified in launcher (§2.1).
- [ ] SYSTEM_ALERT_WINDOW + cleartext rationale pasted into Play review notes (see `docs/play/TV_HARDWARE_COMPATIBILITY.md` §2, §5).
- [ ] Pre-launch report (Play's automated TV crawl) reviewed — expect it to press BACK and D-pad; any "app unresponsive to Back" flag re-tests §4.
- [ ] Data safety form matches reality: no ads SDK, no analytics SDK in the dependency list (`docs/play/NATIVE_COMPATIBILITY.md` §2), network traffic only to the operator's server.
