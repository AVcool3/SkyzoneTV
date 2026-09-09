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
  `keystore/keystore.properties`). **Never lose or regenerate this** — updates
  must be signed with the same key. On Play, opt into **Play App Signing** at
  first upload so Google escrows the app key and a lost upload key can be
  reset.

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

$25 one-time account fee. Expect the whole path to take ~3 weeks for a new
individual account because of the closed-testing requirement.

1. play.google.com/console → create developer account → identity
   verification.
2. Create app → upload `app-release.aab` to a **closed testing** track.
3. **New individual accounts must run a closed test with at least 12 testers
   continuously opted in for 14 days** before they can apply for production.
   Recruit testers (friends, staff — they opt in via a link; they don't need
   TVs, phones count for the opt-in). After 14 days, apply for production
   access and answer the questionnaire honestly (venue signage tool,
   tested on Fire TV/Google TV hardware, etc.).
4. Fill every "App content" section — this is where apps actually get held:
   - **Privacy policy URL** (required): the server hosts one at
     `https://YOUR-APP.onrender.com/privacy.html` — edit the contact line
     in `server/public/privacy.html` first.
   - **Data safety**: declare *no data collected, no data shared* (true: no
     analytics, no ads, no personal data; the screen id is not personal).
   - **Ads**: none. **Content rating** (IARC): utility, suitable for all.
   - **Target audience**: 18+ / "not designed for children" — it's an
     operator tool; do NOT tick child-directed even though venues host kids.
   - **App access** (critical for review — see below).
5. Select the **TV** form factor in release setup. TV apps get an extra
   quality review: leanback launcher entry, TV banner, D-pad-only operation —
   this app satisfies all three (the setup dialog is remote-navigable).
6. Production rollout after approval; reviews take 1–7 days per submission.

## Reviewer access — the #1 avoidable rejection

The app shows a "connect to your server" screen on first launch. A reviewer
with no server sees an empty app and rejects it. Fix by giving them a live
demo in the **App access** notes:

1. Stand up a **demo server instance** (a second free/starter Render service
   from the same repo) with `REQUIRE_TV_APPROVAL` left **unset** and a
   playlist assigned to all TVs — any screen that connects starts playing
   content immediately, no approval step.
2. In App access / testing notes, write: "Enter server address
   `https://skyzone-demo.onrender.com` when prompted. The screen will begin
   playing demo signage content automatically."

## Honest risk assessment

- **The name.** "Skyzone TV Player," published from a personal account, uses
  the Sky Zone trademark. Store impersonation/IP policies can flag it, and
  the brand owner can file a takedown even after approval. Options: get
  written authorization from your franchise/corporate contact and keep it on
  file for an appeal, or publish under a neutral name (the rename is a small
  code change). For your own 12 TVs, sideloading (Downloader →
  `/skyzone-player.apk`) avoids all of this entirely.
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
