# Publishing the player to the app stores

The build artifacts live in `android-player/` after `gradle assembleRelease
bundleRelease`:

- **`app/build/outputs/apk/release/app-release.apk`** — signed APK for the
  Amazon Appstore (Fire TV) and for sideloading.
- **`app/build/outputs/bundle/release/app-release.aab`** — Android App Bundle
  for Google Play (Play only accepts AABs).
- **`store-assets/`** — icon (512×512), feature graphic (1024×500). Use the
  player screenshots from a running screen for listing screenshots (16:9).
- Signing key: `android-player/keystore/upload.jks` (passwords in
  `keystore/keystore.properties`). Both live ONLY on the build machine now —
  they are gitignored and **must never be committed** (they were tracked
  before Sept 2026; treat that key as exposed). On Play, opt into
  **Play App Signing** at first upload so Google escrows the app key; then
  reset the exposed upload key: Play Console → Setup → App signing →
  **Request upload key reset**, generate a fresh keystore
  (`keytool -genkeypair -v -keystore upload.jks -alias parkcast -keyalg RSA
  -keysize 2048 -validity 9125`), and upload its certificate. Keep a copy of
  the new keystore + passwords in a password manager, never in the repo.

## Amazon Appstore (Fire TV) — do this one first

Free account, light review, typically live in 1–3 days.

1. developer.amazon.com → create account (free) → Apps & Services → Add a
   New App → Android.
2. Upload `app-release.apk`. Under device support, target **Fire TV**.
3. Listing: name, description, icon, screenshots, category (Utility /
   Business). Content rating questionnaire: no objectionable content.
4. In testing notes, include a demo server URL (see "Reviewer access" below).
5. Submit.

## Google Play (Google TV / Android TV)

Published from the LLC's **organization** developer account. Organization
accounts are exempt from the 12-testers/14-days closed-testing requirement
that personal accounts have, so the path is: fill in app content → submit →
1–7 days review. No multi-week test gate.

1. play.google.com/console → the org account (already created; make sure
   D-U-N-S/business verification shows complete, or production submission
   stays locked).
2. Create app "ParkCast Player" → upload `app-release.aab`. Use the
   **internal testing** track first — it delivers to your own devices within
   minutes, so you can confirm the store-installed build on the onn box
   before requesting production review.
3. Promote the same release to **production** when it looks good. Answer
   the questionnaire honestly (venue signage tool, tested on Fire TV/Google
   TV hardware, etc.).
4. Fill every "App content" section — this is where apps actually get held:
   - **Privacy policy URL** (required): `https://parkcast.onrender.com/privacy`
     (clean route; verify it loads in an incognito window right before
     submitting).
   - **Data safety**: declare **Device or other IDs — collected, not
     shared, purpose: app functionality, encrypted in transit, deletion
     supported** (the app sends a persistent random screen id plus playback
     status to the ParkCast server; that is a device-scoped identifier, so
     "no data collected" would under-declare). No other data types. Deletion
     instructions URL: `https://parkcast.onrender.com/delete-account`. See
     docs/play/DATA_SAFETY_AUDIT.md for the full question-by-question walk.
   - **Ads**: none. **Content rating** (IARC): utility, suitable for all.
   - **Target audience**: 18+ / "not designed for children" — it's an
     operator tool; do NOT tick child-directed even though venues host kids.
   - **App access** (critical for review — see below).
5. Select the **TV** form factor in release setup. TV apps get an extra
   quality review: leanback launcher entry, TV banner, D-pad-only operation —
   this app satisfies all three (the setup dialog is remote-navigable).
6. Production rollout after approval; reviews take 1–7 days per submission.

## Reviewer access — the #1 avoidable rejection

Since v1.3 the app auto-connects to the built-in ParkCast server on first
launch and shows its 6-digit pairing code immediately — there is no setup
screen (long-press OK/Select opens the server-address dialog if ever
needed). The reviewer needs a way to see content actually play, which
means claiming the screen from a dashboard account.

Follow **docs/play/GOOGLE_REVIEWER_INSTRUCTIONS.md** — it contains the
owner pre-flight (permanent reviewer dashboard account, a pre-built
"Reviewer Demo" playlist) and the paste-ready App access text describing
the claim flow (dashboard → “+ Add screen” → type the code → content
plays). Reviewer credentials must be permanent, work from any location,
and require no OTP or manual activation.

## Honest risk assessment

- **The name.** The store app is published as **ParkCast Player**
  (`com.parkcast.player`) — a neutral name with no third-party trademark in
  it, so store impersonation/IP policies don't apply. Before submitting, do
  a five-minute availability check: search "ParkCast" on Google Play, the
  Amazon Appstore, and tmsearch.uspto.gov; if something conflicting shows
  up, pick another neutral name (it's a one-file rename in
  `res/values/strings.xml` plus the two graphics). For your own 12 TVs,
  sideloading (Downloader → `/parkcast-player.apk`) needs no store review at
  all.
- **"Display over other apps" permission**: allowed, occasionally
  questioned. If review asks, the justification is: kiosk signage device
  must relaunch automatically after power loss without human interaction.
- **WebView-app policies**: Play rejects thin wrappers around *websites*;
  this app is a device client for the operator's own service (device
  pairing, kiosk behavior, boot handling), which is acceptable — say exactly
  that if queried.

## Do you actually need the stores?

For your own park: no — sideloading is faster, and updates ship instantly
from your own server without store review. The stores matter when onboarding
customer venues who shouldn't need Developer Options. Reasonable path:
Amazon first (cheap, fast, covers Fire TV), Play once the closed test
completes.
