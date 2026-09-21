# ParkCast Player — Permission Audit (Google Play)

Audit date: 2026-09-21. Source manifest:
`android-player/app/src/main/AndroidManifest.xml`. Merged release manifest verified at
`android-player/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml`
(lines 11, 12, 17): the final APK/AAB requests **exactly the three declared permissions**,
plus one auto-generated androidx artifact (see §5). No library merges in any additional
runtime-relevant permission.

---

## 1. `android.permission.INTERNET`

- **Declared:** AndroidManifest.xml:4.
- **Why needed:** the entire app is a WebView client of the venue's signage server —
  page load (MainActivity.kt:103), registration fetch (player.js:153), WebSocket
  (player.js:173), and media streaming (player.js:382, 377). Without it the app does
  nothing at all.
- **Protection level:** normal. Granted at install, no user prompt.
- **Runtime permission?** No.
- **Sensitive per Play?** No. Not listed in any Play sensitive-permission program; no
  declaration form; no Data-safety implication by itself (what matters is what is sent —
  see PRIVACY_DATA_INVENTORY.md §3).
- **Removal analysis:** app is 100 % non-functional without it (blank kiosk). Keep.

## 2. `android.permission.RECEIVE_BOOT_COMPLETED`

- **Declared:** AndroidManifest.xml:5. Consumed by the exported `BootReceiver`
  registered for `BOOT_COMPLETED` and `QUICKBOOT_POWERON` (AndroidManifest.xml:35-40;
  action check in BootReceiver.kt:17).
- **Why needed:** signage kiosks power-cycle with the venue (wall switches, power cuts,
  overnight shutdown). The receiver relaunches MainActivity on boot
  (BootReceiver.kt:21-23) so screens come back without a human walking to each TV with a
  remote.
- **Protection level:** normal. Granted at install, no user prompt.
- **Runtime permission?** No.
- **Sensitive per Play?** No declaration form. Reviewers occasionally ask why a TV app
  auto-starts; the kiosk rationale above answers it.
- **Removal analysis:** the receiver never fires; after any reboot the device sits on
  the launcher until manually started. Core kiosk feature lost. Keep.

## 3. `android.permission.SYSTEM_ALERT_WINDOW` ("Display over other apps")

- **Declared:** AndroidManifest.xml:8 (with the in-manifest comment at 6-7 explaining
  the boot use).
- **What it is actually used for — important nuance:** the app **never draws an
  overlay**. No `WindowManager.addView`, no `TYPE_APPLICATION_OVERLAY`, no overlay
  window exists anywhere in the code (MainActivity.kt and BootReceiver.kt are the entire
  native codebase). The permission is held solely because **Android's
  background-activity-launch restriction** (Android 10+/API 29+, and practically also
  the API 23+ overlay gate on activity starts from receivers) blocks a
  `BroadcastReceiver` from starting an activity after boot unless the app holds the
  "Display over other apps" special access. Verified flow:
  - BootReceiver.kt:19-20 — refuses to start the activity unless
    `Settings.canDrawOverlays(context)` is true (skipped below API 23, where the
    permission predates the check and is not needed — comment at 18).
  - MainActivity.kt:110-127 (`ensureBootPermission`) — asks **once** (flag
    `bootPermAsked`, 113-114) via a plain dialog, then deep-links the user to the
    system toggle with `Settings.ACTION_MANAGE_OVERLAY_PERMISSION`
    (MainActivity.kt:120). The app cannot grant it to itself.
- **Protection level:** signature|appop — a **special-access** permission. It is *not* a
  runtime permission dialog; the user must flip a switch in system settings, which is
  exactly what the one-time prompt requests. Declining leaves the app fully functional
  except boot auto-start (dialog offers "Later", MainActivity.kt:125).
- **Sensitive per Play?** Yes — SYSTEM_ALERT_WINDOW is on Play's scrutiny list because
  overlay capability can enable tapjacking/phishing on phones. There is currently no
  mandatory Play Console declaration form for it (unlike SMS/QUERY_ALL_PACKAGES), but
  reviewers do question it, especially combined with BOOT_COMPLETED. On TV form factors
  the phishing surface is essentially nil (no touch, no other-app password entry over a
  leanback launcher; `android.hardware.touchscreen` is declared not required,
  AndroidManifest.xml:11).
- **Data-safety implication:** none — the permission grants no data access; nothing about
  it appears in the Data safety form.
- **Removal analysis:** on API 23+ (every Google TV device Play ships to),
  BootReceiver.kt:19-20 returns early and, even if that guard were removed, the OS would
  silently discard the background activity start. Result: **no recovery after power
  loss**, the single most important reliability feature of a venue signage appliance
  (venues cut power nightly; screens must self-restore before opening). Alternatives
  were assessed: a foreground service started from the receiver still may not launch
  activities without this same special access; device-owner/dedicated-device (Android
  Enterprise kiosk) provisioning is not realistic for consumer-bought Fire TV/onn boxes;
  Fire OS ≤5 needs nothing (BootReceiver.kt:18-20). SYSTEM_ALERT_WINDOW is therefore the
  minimal mechanism available. Keep.

### Paste-ready Play Console justification (if a declaration/appeal asks)

> ParkCast Player is a digital-signage kiosk app for TVs and TV set-top devices in
> commercial venues. It requests "Display over other apps" (SYSTEM_ALERT_WINDOW) for
> exactly one purpose: allowing its BOOT_COMPLETED receiver to relaunch the full-screen
> player automatically after the device reboots — typically after a venue's nightly
> power-down or a power cut — because Android blocks activity launches from the
> background without this special access. The app never draws overlay windows: it holds
> the permission only so `Settings.canDrawOverlays()` is true when the boot receiver
> calls `startActivity()`. The permission is requested once via the system settings
> screen (`ACTION_MANAGE_OVERLAY_PERMISSION`); if the user declines, the app remains
> fully functional and simply does not auto-start after reboots. The app targets TV
> devices (leanback launcher, no touchscreen required), where signage screens run
> unattended and must recover from power loss without staff interaction.

## 4. Permissions deliberately absent (verified nowhere in source or merged manifest)

No location, camera, microphone, storage/media read, contacts, phone state, NEARBY_*,
BLUETOOTH, ACCESS_NETWORK_STATE, WAKE_LOCK (screen-on is done with
`FLAG_KEEP_SCREEN_ON`, MainActivity.kt:37, plus the JS `navigator.wakeLock` request,
player.js:536-539 — neither needs a manifest permission), FOREGROUND_SERVICE, or
advertising-ID permission (`com.google.android.gms.permission.AD_ID` does **not** appear
in the merged manifest — consistent with declaring "no ads / no ad ID" in Data safety).

## 5. Merged-manifest artifact (not user-facing)

`com.parkcast.player.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (merged manifest line 34)
— an androidx-generated, signature-protected *custom* permission that guards
dynamically-registered receivers inside the app itself. Auto-added by androidx.core; not
a device capability, never shown to users, no Play disclosure needed. Listed here so a
future audit of `aapt dump permissions` output is not surprised by it.

## 6. Bottom line

Three permissions, all load-bearing, none granting access to any user data. The only one
Play may question is SYSTEM_ALERT_WINDOW; the justification text in §3 is accurate to
the code and ready to paste.
