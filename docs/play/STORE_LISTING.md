# Store Listing Draft — ParkCast Player

Everything below is ready to paste into Play Console → Grow → Store presence →
Main store listing (and the TV assets section). Claims are limited to what the
shipped app and dashboard actually do (sources: `README.md`,
`server/public/index.html`, `android-player/` and `server/public/` code).

---

## App name (max 30 characters)

```
ParkCast Player
```
(15 characters.)

## Short description (max 80 characters)

```
Turns your Android TV into a managed signage screen for your ParkCast venue.
```
(76 characters.)

## Full description (max 4,000 characters — draft is ~2,600)

```
ParkCast Player turns an Android TV or Google TV device into a full-screen
digital-signage display for your venue — trampoline parks, family
entertainment centers, gyms, restaurants, or any business with TVs on the
wall and something to show on them.

IMPORTANT — THIS APP IS FOR VENUE OPERATORS. It requires a ParkCast venue
workspace (or your own self-hosted ParkCast server). Without one, the app
only displays a pairing code. Contact us at srini.vanukuri@gmail.com to set
up a venue.

SET UP A SCREEN IN UNDER A MINUTE
1. Install the app on the TV and open it — a 6-digit pairing code appears.
2. In your ParkCast web dashboard (phone or laptop), press "+ Add screen"
   and type the code.
3. Assign a playlist. The TV starts playing immediately.
No login on the TV, no keyboard gymnastics with the remote, no USB sticks.

WHAT YOUR SCREENS CAN DO
• Loop playlists of videos and photo slides, with per-item timing and
  optional fade transitions.
• Show boards and slides composed in the dashboard's built-in designer —
  promos, menus, announcements — pushed to screens instantly.
• Run every TV independently: each screen plays its own playlist, and
  changing one never interrupts the others.
• Birthday and event takeovers: upload the day's party schedule (CSV), and
  at each party's start time the right room's TV automatically shows a
  "Happy Birthday" takeover with the guest's name, then returns to its
  normal loop on its own.
• Report live status to the dashboard — see what every screen is playing
  right now, and start or end the whole day with one button.

BUILT FOR UNATTENDED VENUE TVs
• Kiosk behavior: runs full screen, hides system UI, and ignores the BACK
  button so a stray remote press can't kill a screen mid-shift.
• Survives network hiccups: if the connection drops, the player shows a
  clean branded screen and reconnects by itself — never a browser error
  page.
• Survives power cuts: with "Display over other apps" enabled, the player
  relaunches automatically when the TV boots back up.
• Designed for Android TV: appears in the TV launcher row and is fully
  operable with the D-pad remote. No touchscreen required.
• Works with Google TV, Android TV, and Fire TV-class devices (Android 5.1
  and up).

SELF-HOSTED OPTION
Running ParkCast on your own server? Press MENU on the remote to point the
player at any server address, including one on your local network.

PRIVACY
No ads, no analytics, no in-app purchases, no account creation on the TV.
The app talks only to your venue's signage server. Privacy policy:
https://parkcast.onrender.com/privacy

Support: srini.vanukuri@gmail.com
```

Notes on the draft:
- "Android TV" is mentioned explicitly (required for the TV listing).
- No pricing claims (pricing isn't in the product yet — the landing page's
  "one price per venue" is marketing copy, not a store commitment).
- "Android 5.1 and up" matches `minSdk = 22`.
- Do not add feature claims beyond this list without checking the code first.

---

## Graphics assets

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG | Exists: `store-assets/icon-512.png` |
| Feature graphic | 1024×500 PNG/JPG | Exists: `store-assets/feature-graphic-1024x500.png` |
| **TV banner** | **1280×720** PNG/JPG | **Missing — create it** (scale up the art from `android-player/app/src/main/res/drawable/banner.png`, don't just stretch the 320×180 file) |
| TV screenshots | 16:9, capture at **1920×1080**, min 1 required, provide 3–4 | Shot list below |

## Screenshot shot list (capture these real screens at 1920×1080)

Capture from an actual device with the app running — Play wants real frames,
no device bezels, no marketing overlays. On an ADB-connected TV:
`adb exec-out screencap -p > shot-N.png` (frames are 1920×1080 on a 4K box
rendering at 1080p; verify dimensions before upload).

1. **Pairing code screen** — the app's first-run state: ParkCast logo,
   "Code NNNNNN" in the gold box, and the "+ Add screen" hint text. This is
   the screen the reviewer will also see, so showing it in the listing sets
   expectations honestly.
2. **Media loop playing** — a full-screen frame of real signage content
   (a promo video frame or photo slide). Use content you own the rights to;
   do NOT use the color-bar test loop from `sample-media/` (it reads as a
   broken test card in a store listing).
3. **Birthday takeover** — the "Happy Birthday <Name>" takeover with confetti
   over the gradient/video background. Trigger it with the dashboard's
   birthday test button. Use a fictional name (e.g. "Maya") — never a real
   customer's child. Caption it in the listing as a business feature
   ("Automatic party takeovers"), keeping the 18+ operator framing.
4. **Dashboard-made board/slide on the TV** — a frame showing a composed
   board (headline + photos), demonstrating the designer output. Optional
   but recommended fourth shot.

Order them in the listing as 2, 3, 4, 1 (lead with content playing, end with
the pairing screen).

## Category

**Recommendation: App → Business.**

Reasoning: the app's user is a business operator managing venue
infrastructure; established digital-signage players list under Business, so
that's where operators browse and where the app's peers are. "Tools" is the
plausible alternative (it's a utility with no business content of its own),
but Tools is a grab-bag dominated by device utilities (file managers, VPNs)
where a signage client is a category mismatch for both users and the review
context. Amazon's listing (per `docs/STORE-PUBLISHING.md`) uses
Utility/Business as well — keeping Play on Business stays consistent.

Tags (if offered): digital signage, kiosk, business tools.

## Contact & policy fields

| Field | Value |
|---|---|
| Support email (public) | `srini.vanukuri@gmail.com` |
| Website | `https://parkcast.onrender.com` |
| Privacy policy URL | `https://parkcast.onrender.com/privacy` — verify it loads before submitting (service confirmation pending) |

## Release notes for v1.3.1 (max 500 chars, paste into the release)

```
• New screens now connect automatically on first launch — the TV goes
  straight to its pairing code, no setup screen.
• Pair from the dashboard with a 6-digit code.
• More resilient playback: branded reconnect screen instead of browser
  errors, automatic recovery after server restarts and renderer crashes.
```
(Adjust to the real 1.2.1 → 1.3.1 delta before shipping.)
