# Google Play Release Checklist — ParkCast Player

App: **ParkCast Player** (`com.parkcast.player`) · v1.3.1 (versionCode 6) · AAB with Play App Signing
Account: **UnlimitedFun LLC** — an **organization** developer account
Companion docs: [CLOSED_TEST_PLAN.md](CLOSED_TEST_PLAN.md) · [GOOGLE_REVIEWER_INSTRUCTIONS.md](GOOGLE_REVIEWER_INSTRUCTIONS.md) · [STORE_LISTING.md](STORE_LISTING.md)

Work through the sections in order. Every item is a manual Play Console step (or a
prerequisite for one). Console navigation labels are given as they appear in the
current Play Console; if Google renames a menu, search the Console's search box
for the section name.

---

## 0. Current state (verify before touching anything)

- [ ] The app already exists in the Console with a prior **internal testing**
      release, v1.2.1. The new upload is **v1.3.1, versionCode 6** —
      versionCode must be strictly higher than every previously uploaded
      build (check what the Console shows; the repo previously built v1.3 as
      versionCode 5).
- [ ] The build is an **.aab** (`android-player/app/build/outputs/bundle/release/app-release.aab`),
      signed with the upload key. Play only accepts AABs for new releases.
- [ ] **Play App Signing is enrolled** (Release → Setup → App signing shows a
      Google-held app signing key distinct from your upload key).
- [ ] **Upload key reset completed.** The original `keystore/upload.jks` was
      tracked in git before Sept 2026 and must be treated as exposed
      (see `docs/STORE-PUBLISHING.md`). The v1.3.1 build is signed with a
      freshly generated upload key (alias `parkcast`). Confirm the Console
      side too: Release → Setup → App signing → **Request upload key reset**
      was completed and the registered upload certificate fingerprint matches
      the NEW keystore (`keytool -list -v -keystore upload.jks`). The new
      keystore + passwords live only on the build machine and in a password
      manager, never the repo. An AAB signed with a key the Console doesn't
      recognize is rejected at upload — do not skip this cross-check.

---

## 1. Developer verification (deadline: September 30, 2026 — hard blocker)

Google requires verified developer identity for apps to remain installable on
certified Android devices. For an organization account, every item below must
show green in the Console before that date — and production submission is
blocked until account verification is complete anyway.

Location: Play Console → (account-level) **Settings → Developer account →
Account details / Verification**, plus the **Android Developer Console** for
package registration.

- [ ] **Legal entity name** — must read exactly as the LLC is registered
      ("UnlimitedFun LLC"), matching state registration documents.
- [ ] **Legal address** — the LLC's registered address, matching the documents
      Google is given. PO boxes are typically rejected.
- [ ] **D-U-N-S number** — organization accounts must supply one. If the LLC
      does not have one yet, request it free at dnb.com (allow up to 30 days —
      this is the longest-lead-time item in this whole checklist). The company
      name/address in the D&B record must match the Play Console legal entity
      exactly, or verification bounces.
- [ ] **Developer email** — verified (click the confirmation link). This is the
      account contact, separate from the public support email.
- [ ] **Developer phone** — verified via SMS/call code.
- [ ] **Payment profile** — a Google Payments profile linked to the developer
      account whose name/address matches the legal entity. Even though the app
      is free, an organization account requires a matching payments profile for
      verification.
- [ ] **Identity documents** — if Google asks, upload official LLC registration
      / authorized-representative ID. Status must reach **Verified**, not
      "In review".
- [ ] **Package registration status** — under the developer-verification
      program, package names must be registered to the verified developer.
      `com.parkcast.player` is registered automatically for Play-published apps
      once the account is verified; confirm the app's package shows no
      verification warning in the Console dashboard. (If you also distribute
      the sideload APK from the server — `/parkcast-player.apk` — the same
      package registration covers it, since it is the same package name signed
      by keys you control; check the Android Developer Console messaging closer
      to the deadline for any extra sideload registration step.)
- [ ] **Deadline check**: all of the above shows **Verified** well before
      **September 30, 2026**. Unverified accounts face installation blocks on
      certified devices and cannot submit.

---

## 2. App content declarations (Policy → App content)

This is where TV/utility apps actually get held up. Complete every card; each
one below lists the honest answer for THIS app.

### 2.1 Privacy policy
- [ ] URL: `https://parkcast.onrender.com/privacy`
- [ ] **Before pasting it**: open the URL in an incognito window and confirm it
      returns the policy (HTTP 200, no login, no redirect to a parked page).
      The Render service confirmation was still pending at the time of writing
      — if the service is asleep or renamed, fix that first. Google fetches
      this URL during review; a dead link is an automatic rejection.
- [ ] The policy page (`server/public/privacy.html`, served at `/privacy`)
      already names the app, the package, and UnlimitedFun LLC. Good.

### 2.2 App access
- [ ] Select **"All or some functionality in my app is restricted"** — the TV
      app itself has no login, but full functionality (content playing) is only
      visible after an operator claims the screen from the web dashboard, so a
      reviewer needs instructions and a dashboard account.
- [ ] Add one instruction set. Paste the block from
      [GOOGLE_REVIEWER_INSTRUCTIONS.md](GOOGLE_REVIEWER_INSTRUCTIONS.md) and
      fill in the permanent reviewer credentials there first.
- [ ] Credentials rules (Google enforces these): the account must be
      **permanent** (never expires), **work from any location**, require **no
      OTP/2FA**, and need **no manual activation** by you. The instructions doc
      covers how to set that up.

### 2.3 Ads
- [ ] Declare **"No, my app does not contain ads"**. True: no ad SDKs, no house
      ads, nothing. (Venue promo content shown by operators on their own
      screens is app content, not advertising served by the app.)

### 2.4 Content rating (IARC questionnaire)
- [ ] Email address: use `srini.vanukuri@gmail.com` (rating certificates are
      sent there).
- [ ] Category: select **Utility, Productivity, Communication, or Other** —
      ParkCast Player is a display tool, not a game or media-content app.
- [ ] Answer **No** to all content questions (violence, sexuality, language,
      controlled substances, gambling): the app itself renders whatever the
      venue uploads, but the questionnaire rates the app as shipped, and the
      app ships no such content.
- [ ] "Does the app share user-generated content with other users?" — **No**.
      Operator-uploaded signage shown on the operator's own screens is not a
      UGC-sharing platform (no user community, no public sharing).
- [ ] "Does the app share the user's location?" / "digital purchases" /
      "unrestricted internet access"? — No, No, and **No** for browsing: the
      WebView loads only the configured signage server, there is no URL bar or
      browsing capability. If the questionnaire asks whether the app can access
      the internet at all, that answer is Yes (it is a networked client).
- [ ] Expected outcome: **Everyone / PEGI 3** class ratings. If it comes back
      higher, re-check your answers before submitting.

### 2.5 Target audience and content
- [ ] Target age group: **18 and over** only. Do NOT select any child age
      bands, and do NOT declare the app as appealing to children.
- [ ] **Reasoning to give if queried** (and to keep straight internally): the
      *user* of this app is an adult venue employee — the person who installs
      it, pairs it, and operates the dashboard. The *content on screen* may
      include kids' birthday-party names because venues host children's
      parties, but children are not the app's users, the app is not directed at
      children, it collects nothing from anyone, and a wall-mounted signage TV
      is not a device a child "uses". This is the same position stated in the
      privacy policy's Children section — keep the two consistent.
- [ ] "Could your store listing unintentionally appeal to children?" — **No**
      (keep listing screenshots operator-oriented; the birthday-takeover
      screenshot shows a business feature, not a kids' app — caption it that
      way in the listing).

### 2.6 Data safety
The app transmits two things to the venue's signage server: a randomly
generated screen identifier (so the dashboard can tell screens apart) and
playback status. The default server (`parkcast.onrender.com`) is operated by
UnlimitedFun LLC, so "the developer receives it" is the safe reading. Declare
it — under-declaring is the #1 cause of Data safety enforcement.

- [ ] "Does your app collect or share any of the required user data types?" —
      **Yes**.
- [ ] Data type: **Device or other IDs → Device or other IDs** — Collected:
      Yes. Shared: **No**.
- [ ] Ephemeral: No (the screen ID persists while paired).
- [ ] Required or optional: **Required** (pairing cannot work without it).
- [ ] Purpose: **App functionality** only.
- [ ] Everything else (location, personal info, financial, health, messages,
      photos, audio, contacts, calendar, app activity, browsing, install'd
      apps, crash logs/diagnostics): **Not collected**. True — no analytics,
      no crash SDK, no ads, no personal data, and the app cannot read files,
      camera, mic, or location.
- [ ] Security practices: **Data is encrypted in transit** — Yes for the
      as-shipped configuration (the built-in default server is HTTPS). Note:
      the app permits `http://` for operator-entered LAN servers; that is an
      operator-configured deployment, and the declaration describes the app as
      distributed.
- [ ] "Provides a way to request deletion": **Yes** — an operator deletes the
      screen (and its ID) from the dashboard at any time; uninstalling clears
      everything on-device; the privacy policy documents a 30-day deletion
      contact. Point the deletion field at
      `https://parkcast.onrender.com/privacy`.
- [ ] Consistency check: the privacy policy's "Data we collect" section says
      "no personal information" and then separately discloses the screen
      identifier under "What the app transmits" — the Data safety form above
      matches the *transmits* section. Do not declare "no data collected" in
      the form while the app demonstrably sends a persistent device-scoped ID
      to a developer-operated server.

### 2.7 Remaining App content cards
- [ ] **Government apps** — No.
- [ ] **Financial features** — None of the listed features.
- [ ] **Health apps** — Not a health app.
- [ ] **News apps** — No.
- [ ] **COVID-19 apps** — No (if still shown).
- [ ] **Advertising ID** — the app does not use the advertising ID (no ads/
      analytics SDKs); declare **No**. (targetSdk 36 means this declaration is
      mandatory.)

---

## 3. Android TV form factor opt-in

The app is TV-only (leanback launcher entry, `leanback required="true"` in
the manifest, landscape, D-pad operable, no touch requirement). It must still
be explicitly opted in to the TV form factor in the Console or it will never
surface on Google TV devices.

- [ ] Play Console → **Release → Setup → Advanced settings → Form factors** tab
      → **Add form factor → Android TV**.
- [ ] Submitting the TV form factor triggers Google's separate **TV quality
      review** (can add days/weeks to the first TV approval). The app already
      satisfies the core checks:
      - `LEANBACK_LAUNCHER` intent category — yes (`AndroidManifest.xml`).
      - `android:banner` present — yes (`res/drawable/banner.png`, must be
        320×180).
      - `android.hardware.touchscreen required="false"` — yes.
      - Fully D-pad operable — yes (the only UI is the server-address dialog
        and the boot-permission dialog, both standard AlertDialogs; MENU opens
        the address dialog; BACK is intentionally swallowed for kiosk mode —
        that is acceptable for a signage player but mention it in review notes
        if asked).
- [ ] The manifest now declares `android.software.leanback` as **required**,
      so Play device targeting is TV-only — phones and tablets are filtered
      out automatically. Confirm in the Console (Release → Device catalog)
      that supported devices are TV devices only; that also removes
      phone-form-factor screenshot pressure and phone pre-launch crawls.

## 4. TV store listing assets

- [ ] **TV banner: 1280×720** PNG/JPEG — required for a TV listing. Not in
      `store-assets/` yet; create it from the same art as the in-app banner.
- [ ] **App icon 512×512** — exists: `store-assets/icon-512.png`.
- [ ] **Feature graphic 1024×500** — exists:
      `store-assets/feature-graphic-1024x500.png`.
- [ ] **TV screenshots**: at least **1** real 16:9 TV screenshot is required —
      provide **3–4** (Play rewards more; reviewers distrust a single shot).
      1920×1080, actual app frames, no device mockup borders. Shot list and
      capture commands: [STORE_LISTING.md](STORE_LISTING.md).
- [ ] The full description **mentions Android TV** explicitly (a TV-listing
      requirement) — the draft in STORE_LISTING.md does.

## 5. Main store listing

- [ ] Fill **Grow → Store presence → Main store listing** from
      [STORE_LISTING.md](STORE_LISTING.md): name, short description, full
      description, graphics, category (**Business**), contact email
      `srini.vanukuri@gmail.com`, privacy policy URL.
- [ ] Store settings → App category: **App → Business**. Contact details:
      support email is required and public.

---

## 6. Release flow (internal → closed → production)

- [ ] **Internal testing** first: Release → Testing → Internal testing → create
      release → upload `app-release.aab` (v1.3.1 / 6) → add your own Google
      accounts as testers → install on the real onn/Fire TV hardware from the
      Play Store link and confirm the store-delivered build pairs and plays.
      Internal testing propagates in minutes and needs no review.
- [ ] **Closed testing**: promote the same release to a Closed track. For this
      **organization account** a closed test is *recommended but not required*
      before production — run the abbreviated plan in
      [CLOSED_TEST_PLAN.md](CLOSED_TEST_PLAN.md) anyway; it is the cheapest
      place to catch TV-quality-review issues. (If the app were on a personal
      account, the closed test would be mandatory — see the same doc.)
- [ ] **Production**: promote the tested release. First production submission
      of a TV app gets the full review (1–7 days typically; TV quality review
      can be longer). Country availability: start with the countries you can
      support (US at minimum), expand later.
- [ ] Release notes for v1.3.1: short, honest ("Automatic connection to your
      ParkCast workspace on first boot; pairing-code flow; reliability fixes
      for overnight playback and reboot recovery" — adjust to match the actual
      1.2.1→1.3.1 changes).

## 7. Pre-launch report

- [ ] After each track upload, open **Release → Testing → Pre-launch report**
      (or Test and release → Pre-launch report) and review every tab: crashes,
      ANRs, performance, accessibility, security warnings.
- [ ] Expected noise, with dispositions:
      - Crawler devices are phones/tablets; a kiosk TV WebView app may just
        show the "Connecting…"/pairing screen to the crawler. That is fine —
        no crash is the bar.
      - **Cleartext traffic warning**: `usesCleartextTraffic="true"` is
        deliberate (self-hosted LAN servers use `http://`). Not a rejection,
        but note the justification in case review asks.
      - `SYSTEM_ALERT_WINDOW` ("Display over other apps") may be flagged as a
        sensitive permission. Justification if queried: *a kiosk signage
        device must relaunch the player automatically after a power cut,
        without a human present; the permission is requested once, with an
        explanatory dialog, and is declinable.*
- [ ] Fix any genuine crash before promoting to production; do not promote a
      build whose pre-launch report shows a crash on a TV-profile device.

## 8. Production access application (only if the Console asks)

Organization accounts normally get production access without the testing-gate
application. If the Console nevertheless presents an "Apply for production
access" questionnaire (it does for personal accounts created after
Nov 13, 2023, and occasionally for accounts with limited history), answer
honestly — these work:

- **Who is your app for?** — "Employees of entertainment venues (trampoline
  parks, family entertainment centers). It turns the venue's Android TV
  devices into managed digital-signage screens controlled from the venue's
  web dashboard. It is a B2B operator tool, not a consumer app."
- **How did you recruit your testers?** — "Venue staff and the operators of
  our pilot venue, plus friends/family with Android TV or Google TV devices.
  All testers were adults using real TV hardware."
- **How did testers engage with the test?** — "Testers installed the app on
  Android TV/Fire TV devices, paired screens to a live dashboard workspace via
  the 6-digit code, ran content loops for multi-day soak periods including
  overnight, and exercised failure cases (network unplug/reconnect, power
  cycling, server restarts)."
- **Summarize the feedback and what you changed.** — Use the real contents of
  your CLOSED_TEST_REPORT.md (see CLOSED_TEST_PLAN.md); typical honest content:
  reconnection timing, remote-navigation focus fixes, overnight-playback
  stability.
- **How did you decide your app is ready for production?** — "It has run as
  the production signage system at a live venue on 12 screens for [N] weeks,
  survives power loss and network outages unattended, and completed the
  14-day closed test with no crashes."
- Do NOT inflate tester counts or invent feedback — Google can see the
  actual opt-in numbers on your closed track.

## 9. Submit and monitor

- [ ] Send the production release for review. Do not unpublish the internal/
      closed tracks — keep them for future versions.
- [ ] While in review, do not touch App content answers (edits can reset the
      review queue).
- [ ] After approval: install from the public listing on a clean device,
      re-run the pairing flow end-to-end, and check the listing renders
      correctly on a Google TV device's store.
- [ ] Calendar reminders: **D-U-N-S / verification re-checks** (Google
      periodically re-verifies), **target API level** deadline each August
      (currently satisfied: targetSdk 36), and keeping the reviewer account in
      App access alive for as long as the app is published (Google re-reviews
      existing apps and will use those credentials again).
