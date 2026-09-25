# Play Release Readiness — ParkCast Player 1.3.1 (versionCode 6)

Final gate for the Google Play Android TV submission. Statuses: **PASS**
(verified in this repo/build), **MANUAL** (only the account owner can do or
verify it), **N/A** (requirement does not apply). There are **no FAIL items
and no code-side blockers** as of this document's commit.

Companion docs (all in `docs/play/`): TV_HARDWARE_COMPATIBILITY,
NATIVE_COMPATIBILITY, ANDROID_TV_TEST_PLAN, PRIVACY_DATA_INVENTORY,
PERMISSION_AUDIT, SDK_DATA_AUDIT, SECRET_AUDIT, DATA_SAFETY_AUDIT,
GOOGLE_PLAY_RELEASE_CHECKLIST, CLOSED_TEST_PLAN,
GOOGLE_REVIEWER_INSTRUCTIONS, STORE_LISTING.

## 1. Build — PASS
- Release AAB and APK build clean; artifact `app-release.aab` (~2.5 MB).
- targetSdk 36 (TV requires ≥34), minSdk 22 (TV Ready requires ≤31),
  compileSdk 36, versionCode 6, versionName 1.3.1.
- Release-signed (new upload key, alias `parkcast`, O=UnlimitedFun LLC,
  valid to 2051), not debuggable, not testOnly, no dev/staging endpoints
  (only `DEFAULT_SERVER_URL=https://parkcast.onrender.com`).

## 2. TV compatibility — PASS
- `android.software.leanback` required=true (TV-only), touchscreen
  required=false, `LEANBACK_LAUNCHER` on the exported MainActivity,
  landscape locked; nothing declares hardware TVs lack (verified in the
  built bundle's badging, not just source).
- Banner 320×180 in drawable-xhdpi with visible app name; icon 320×320;
  1280×720 Console store banner + three genuine 1080p screenshots in
  `store-assets/`.

## 3. D-pad and remote — PASS (+1 MANUAL)
- The player surface is deliberately display-only: no focusable web
  content exists, so nothing can be unreachable.
- All native dialogs (server address, boot permission, exit) are stock
  AlertDialogs — D-pad navigable with visible focus.
- BACK: single press ignored (kiosk), 3 presses within 2s open an exit
  dialog defaulting to "Keep playing" — Exit returns to the TV home
  screen, satisfying the review requirement.
- Settings reachable on every remote: MENU or long-press OK/Select.
- MANUAL: one pass on physical hardware (Gboard TV in the URL dialog,
  overlay-permission flow) per ANDROID_TV_TEST_PLAN.md.

## 4. Privacy — PASS (+2 MANUAL judgment sign-offs)
- Exactly one datum leaves the device: the random server-issued screen id
  (plus a name-free playback status — the birthday-name echo was removed
  in this release). Nothing persisted beyond `serverUrl`, `bootPermAsked`,
  and the tvId.
- Zero logging of sensitive values in app or first-party JS; the server
  no longer prints an env-configured ADMIN_PASSWORD to retained logs.
- Finished parties auto-purge after 30 days (children's names don't sit
  in the database indefinitely).
- Self-service data deletion is live: any dashboard user can delete their
  own account, an owner can erase the whole venue (files, screens,
  playlists, parties, accounts, sessions — immediate, no soft-delete),
  and the public how-to page at `/delete-account` is the URL to give the
  Data safety form's deletion field.
- Privacy policy consistent with behavior (UnlimitedFun LLC's operation
  of the default server is now stated plainly; links /delete-account).
- MANUAL: owner signs off the two documented judgment calls — the
  "Device or other IDs" declaration and "encrypted in transit: Yes" with
  the LAN-mode rationale (DATA_SAFETY_AUDIT.md).

## 5. Security — PASS (+1 MANUAL)
- 3 permissions total, each justified (PERMISSION_AUDIT.md, with
  paste-ready SYSTEM_ALERT_WINDOW text); no third-party SDKs at all.
- No secrets in the app or repo working tree; server credentials are
  env-only; keystore gitignored.
- HTTPS default everywhere, including typed addresses without a scheme;
  cleartext remains possible only when an operator deliberately enters
  http:// for a LAN server (documented tradeoff — Android NSC cannot
  whitelist by IP range).
- MANUAL: complete the Play App Signing **upload-key reset** — the old
  key + passwords remain extractable from git history and are treated as
  burned. The new certificate is `keystore/upload_certificate.pem`.

## 6. 64-bit / 16 KB — PASS
Pure Kotlin/Java: zero `.so` files in source, APK, and AAB (verified by
archive listing); both dependencies are androidx JVM artifacts. Compliant
by construction (NATIVE_COMPATIBILITY.md).

## 7. Permissions — PASS
See §5; merged manifest of the built bundle contains exactly the three
declared permissions plus androidx's benign internal one.

## 8. Store listing & reviewer access — MANUAL (everything prepared)
- Listing text (name/short/full), category, contact, privacy URL:
  STORE_LISTING.md. Assets: `store-assets/`.
- Reviewer flow + paste-ready App access text:
  GOOGLE_REVIEWER_INSTRUCTIONS.md. Owner must create the permanent
  reviewer dashboard account and the "Reviewer Demo" playlist, and
  confirm https://parkcast.onrender.com/privacy returns 200 publicly.
- Android TV form-factor opt-in and all App content cards:
  GOOGLE_PLAY_RELEASE_CHECKLIST.md.

## 9. Closed testing — MANUAL
Organization (UnlimitedFun LLC) account: the 12-tester/14-day gate for
personal accounts most likely does not apply; the 14-day plan and tester
script are ready in CLOSED_TEST_PLAN.md and are recommended regardless.
Verify Play Console does not show a testing requirement before counting
on this.

## 10. Remaining blockers
**Code: none.** Owner-side, in order:
1. Developer verification for the LLC (D-U-N-S lead time up to 30 days;
   Sept 30, 2026 deadline).
2. Play App Signing upload-key reset with the new certificate (blocks
   uploading the v1.3.1 AAB).
3. Production Render service confirmed live with env vars + privacy URL
   reachable.
4. Reviewer account + demo playlist provisioned; App access filled in.
5. Console work per GOOGLE_PLAY_RELEASE_CHECKLIST.md, then internal →
   closed → production with the pre-launch report reviewed at each step.
