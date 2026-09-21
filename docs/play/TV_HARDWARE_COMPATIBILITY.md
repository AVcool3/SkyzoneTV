# TV Hardware Compatibility Audit — ParkCast Player

**App:** `com.parkcast.player` v1.3 (versionCode 5) · minSdk 22 · targetSdk 36 · compileSdk 36
**Audit date:** 2026-09-21
**Scope:** Google Play 2026 TV requirements (TV Ready / Tier 3) — hardware feature declarations, permission-implied features, component export correctness, and TV input operability.
**Sources audited (verified by reading, not assumed):**
- `android-player/app/src/main/AndroidManifest.xml`
- Merged manifest: `android-player/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml`
- Manifest merger report: `android-player/app/build/outputs/logs/manifest-merger-release-report.txt`
- `android-player/app/src/main/java/com/parkcast/player/MainActivity.kt`
- `android-player/app/src/main/java/com/parkcast/player/BootReceiver.kt`
- `android-player/app/src/main/res/values/strings.xml`, `themes.xml`
- Built artifacts: `app/build/outputs/apk/release/app-release.apk`, `app/build/outputs/bundle/release/app-release.aab`

---

## 1. Declared `<uses-feature>` elements

| Feature | Declared | Location | TV verdict |
|---|---|---|---|
| `android.hardware.touchscreen` | `required="false"` | `AndroidManifest.xml:11` | **PASS.** Mandatory for TV distribution — TVs report no touchscreen; `required="false"` prevents Play from filtering the app off every TV. Correctly declared. |
| `android.software.leanback` | `required="false"` (being changed to `required="true"`) | `AndroidManifest.xml:12` | **PASS (with planned change).** `required="false"` makes the app installable on phones and TVs; `required="true"` makes it TV-only. For a signage/kiosk player with no phone UI, `required="true"` is the correct final state and is the pre-agreed change. Either value satisfies the TV distribution requirement (the feature must be *declared*; TV Ready requires the app to be leanback-capable). |

No other `<uses-feature>` elements are declared in the source manifest, and the merged manifest confirms **no library injected any additional feature** (merger report lists exactly these two: `manifest-merger-release-report.txt`, entries `uses-feature#android.hardware.touchscreen` and `uses-feature#android.software.leanback`).

### Features deliberately NOT declared (and why that is correct)

| Feature | Status | Verdict |
|---|---|---|
| `android.hardware.faketouch` | Not declared | OK. Declaring `touchscreen required="false"` is the Google-documented way to state D-pad-only operability; TV devices declare faketouch and are not filtered. No action needed. |
| `android.hardware.camera` / `microphone` / `location` / `telephony` / `bluetooth` / `wifi` / sensors | Not declared, not implied (see §2) | OK — none used, none implied, so no TV device is filtered and no "requires hardware TVs lack" condition exists. |
| `android.hardware.type.television` (legacy) | Not declared | OK — deprecated; `android.software.leanback` is the current signal. |

## 2. Permissions and their implied features

The app requests exactly three permissions (`AndroidManifest.xml:4-8`), confirmed against the merged manifest and merger report — the only addition from libraries is the androidx-generated `com.parkcast.player.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (signature-level, self-owned, injected by androidx.core for runtime-receiver hardening; no Play or TV impact).

Checked against Google's "permissions that imply feature requirements" table (CAMERA→camera, RECORD_AUDIO→microphone, ACCESS_FINE/COARSE_LOCATION→location, CALL_PHONE et al.→telephony, ACCESS_WIFI_STATE/CHANGE_WIFI_STATE→wifi, BLUETOOTH*→bluetooth):

| Permission | Manifest line | Implied feature | Available on Android TV? | TV verdict |
|---|---|---|---|---|
| `android.permission.INTERNET` | `AndroidManifest.xml:4` | **None** (INTERNET is not in the implied-feature table) | n/a | **PASS.** Normal permission, auto-granted, universally available on TV. |
| `android.permission.RECEIVE_BOOT_COMPLETED` | `AndroidManifest.xml:5` | **None** | Yes — TVs deliver `BOOT_COMPLETED` | **PASS.** Normal permission. Standard for signage auto-start. No Play declaration form required. |
| `android.permission.SYSTEM_ALERT_WINDOW` | `AndroidManifest.xml:8` | **None** | Partially — see notes | **PASS with notes.** No hardware implication, so no Play filtering. It is a special-app-access permission: it is *never auto-granted*; the user must enable "Display over other apps". The app degrades gracefully without it (`BootReceiver.kt:19-20` returns early if not granted; `MainActivity.kt:110-127` asks exactly once and offers "Later"), which satisfies the TV-quality rule that an app must remain functional when an optional permission is denied. **Notes:** (a) on some TV builds the `ACTION_MANAGE_OVERLAY_PERMISSION` Settings screen does not resolve — the code already catches `ActivityNotFoundException` twice (`MainActivity.kt:119-123`), so no crash; (b) Play reviewers scrutinize SYSTEM_ALERT_WINDOW — the in-app rationale string (`strings.xml:10`) plus this doc's justification (auto-relaunch after power loss on unattended venue screens, required because Android 10+ blocks background activity starts from `BootReceiver` without it) should be repeated in Play Console review notes. |

**Conclusion for §1–2: no permission or feature in this app implies hardware that TV devices lack. The app is not filtered off any Android TV / Google TV device.**

## 3. Component export correctness

| Component | Exported | Verdict |
|---|---|---|
| `MainActivity` (`AndroidManifest.xml:21-32`) | `exported="true"` | **REQUIRED & CORRECT.** It is the `MAIN`/`LAUNCHER`/`LEANBACK_LAUNCHER` entry point; launcher activities must be exported. `LEANBACK_LAUNCHER` category is present (`AndroidManifest.xml:30`) — mandatory for TV Ready. |
| `BootReceiver` (`AndroidManifest.xml:35-40`) | `exported="true"` | **REQUIRED & CORRECT** for receiving `BOOT_COMPLETED` with an explicit `exported` value (mandatory since API 31 when an intent filter is present). `BOOT_COMPLETED` is a **protected broadcast** (only the system can send it), so export is safe. **Minor note (LOW):** `android.intent.action.QUICKBOOT_POWERON` (`AndroidManifest.xml:38`) is *not* a protected broadcast — any co-installed app could send it and launch the player. Impact is benign (it can only start the kiosk activity, and only when the overlay permission is granted — `BootReceiver.kt:17-23` verifies the action string and permission first). Acceptable; optional hardening is to drop QUICKBOOT on non-HTC/Fire devices. |

No other components, providers, or services exist (verified: `app/src/main` contains only the two Kotlin files, two value XMLs, the manifest, and two PNGs).

## 4. Input operability (D-pad) — TV Ready functional review

| Area | Evidence | Verdict |
|---|---|---|
| Core UI is display-only WebView | `MainActivity.kt:39-40` — the content view is a bare `WebView`; the loaded page has no focusable/interactive elements (see `docs/play/ANDROID_TV_TEST_PLAN.md` §Web player) | **PASS** — nothing on the main screen needs D-pad focus. |
| Server-address dialog | `MainActivity.kt:137-153` — framework `AlertDialog` with an `EditText`. AlertDialog buttons and EditText are D-pad focusable; text entry uses the TV on-screen IME. BACK cancels the dialog (dialog window consumes keys before the activity's `onKeyDown`, and the dialog is cancelable because `serverUrl` is always seeded at `MainActivity.kt:100-102`). | **PASS, with one HIGH finding:** the dialog is reachable **only via `KEYCODE_MENU`** (`MainActivity.kt:156-159`). Many shipping Google TV remotes (Chromecast with Google TV, most 2021+ Google TV OEM remotes) **have no MENU button**, making a shipped feature unreachable from the standard remote — a TV-quality functional failure ("all functionality accessible via D-pad core buttons"). Recommendation: additionally open the dialog on a long-press of DPAD_CENTER/ENTER (see change list in the audit report). IME entry itself: MANUAL VERIFICATION on hardware. |
| Boot-permission dialog | `MainActivity.kt:115-126` — two-button `AlertDialog`, no text input. Buttons are D-pad focusable. Shown once ever (`bootPermAsked`, `MainActivity.kt:113-114`), so it cannot nag an unattended screen. | **PASS.** |
| BACK handling | `MainActivity.kt:161` — `KEYCODE_BACK` is unconditionally consumed while the player is frontmost. | **FINDING (BLOCKER-risk for review, see below).** |
| Landscape | `AndroidManifest.xml:24` `screenOrientation="landscape"` | **PASS** — TVs are landscape; matches TV Ready. (Android 16's ignore-orientation-restrictions change targets large-screen form factors, not TV — MANUAL VERIFICATION of Play pre-launch report advisable since targetSdk is 36.) |
| Fullscreen/immersive | `MainActivity.kt:170-180`, re-asserted on focus at `165-168`; theme is fullscreen black (`themes.xml:3-6`) | **PASS** — correct for signage; no status/nav artifacts on TV. |

### BACK-button analysis (kiosk vs. TV Ready)

TV app quality requires that the Back button behaves predictably and that a user can exit the app — "repeated BACK returns to the TV home screen" is the reviewer's test. As written, BACK is a dead end forever (`MainActivity.kt:161`), which **fails that check and is the single most likely functional rejection in TV review**.

Two facts frame the fix:

1. **HOME cannot be intercepted on Android TV.** A viewer with the remote can always leave via HOME regardless of BACK handling — so consuming BACK provides no real kiosk protection anyway; it only costs review risk.
2. **The accepted pattern for kiosk/signage apps distributed through Play** (as opposed to EMM lock-task deployments, where Play review doesn't apply) is *guarded exit*: single BACK is absorbed (protects against accidental presses mid-shift), but a deliberate repeated gesture exits — e.g. "press BACK 3 times within 2 seconds" or "single BACK shows an Exit? dialog with a 5s auto-dismiss".

**Concrete recommendation:** keep consuming a lone BACK, but on 3 BACK presses within ~2 s show a small D-pad-focusable confirmation ("Exit ParkCast Player?" → Exit / Keep playing, default focus on Keep playing) whose Exit calls `finishAndRemoveTask()`. This preserves the kiosk feel (a toddler mashing the remote once does nothing; the boot receiver relaunches after power cycles regardless), satisfies "repeated BACK returns to home", and is trivially demonstrable to a reviewer. True lock-down deployments should use Android Enterprise lock task / Fire TV launcher pinning, not BACK suppression.

## 5. Application-level manifest items

| Item | Evidence | Verdict |
|---|---|---|
| `android:banner` | `AndroidManifest.xml:16` → `res/drawable/banner.png`, **320×180 px RGB (verified with PIL/file)** — exactly the required 16:9 xhdpi size. Content (pixels inspected): dark navy gradient, "PARKCAST" wordmark (white + orange), subtitle "VENUE SCREEN PLAYER". The app name is visibly present. | **PASS**, with a MEDIUM note: the file lives in `res/drawable/` (density-unqualified = mdpi), so xhdpi TV launchers upscale it 2× and it may render soft. Move it unchanged to `res/drawable-xhdpi/banner.png`. |
| Launcher icon | `AndroidManifest.xml:17` → `res/drawable/icon.png`, **320×320 px RGB (verified)** — square, ≥160×160. Content: orange gradient, "PC" monogram + "PARKCAST". | **PASS** (same drawable-bucket note applies; cosmetic only). |
| `usesCleartextTraffic="true"` | `AndroidManifest.xml:18` | **Deliberate, documented tradeoff** (LAN installs at venues use plain-HTTP servers; the default cloud URL `https://parkcast.onrender.com` in `app/build.gradle.kts:29` is HTTPS). Not a TV-filtering or TV Ready item. Optional hardening: a network-security-config permitting cleartext only for private address space. Keep the rationale in Play review notes. |
| `configChanges="orientation|screenSize|keyboard|keyboardHidden"` | `AndroidManifest.xml:25` | PASS — avoids WebView teardown on config changes; correct for signage. |
| `FLAG_KEEP_SCREEN_ON` | `MainActivity.kt:37` | PASS — the sanctioned no-permission wake mechanism; only active while the player is frontmost. (Whether retail Google TV ambient mode/screensaver is fully suppressed: MANUAL VERIFICATION on hardware.) |

## 6. Overall verdict

- **No hardware filter excludes this app from any Android TV / Google TV device.** All three permissions imply no features; both declared features are `required="false"` (leanback moving to `true` = TV-only, still valid).
- **Manifest structure meets TV Ready**: LEANBACK_LAUNCHER present, touchscreen not required, banner present at correct pixel size with app name, landscape enforced, components exported exactly as required.
- **Two functional-review risks remain, both in input handling, both fixable in `MainActivity.kt` alone:** (1) BACK permanently consumed — add a guarded exit path; (2) settings dialog reachable only via a MENU key many remotes lack — add a long-press alternative. See the change list in the audit report and the test plan (`docs/play/ANDROID_TV_TEST_PLAN.md`).
