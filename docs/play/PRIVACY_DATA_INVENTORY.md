# ParkCast Player — Privacy Data Inventory (Google Play)

Audit date: 2026-09-21. App: `com.parkcast.player` v1.3 (versionCode 5).
Scope: everything that **persists on the TV device** or **leaves the TV device**, traced
from the actual code paths: `android-player/app/src/main/java/com/parkcast/player/MainActivity.kt`,
`BootReceiver.kt`, and the WebView payload `server/public/player/player.js` /
`server/public/player/index.html` (the app is a kiosk WebView that loads `/player/` from the
configured server — MainActivity.kt:129-135).

Every claim below carries a file:line reference to the code that was read for this audit.
Nothing is inferred from documentation.

---

## 1. Architecture in one paragraph (verified)

MainActivity creates a WebView (MainActivity.kt:39), enables JS + DOM storage
(MainActivity.kt:43-49), and loads `<serverUrl>/player/` (MainActivity.kt:103, 129-135).
The default server is baked in as `BuildConfig.DEFAULT_SERVER_URL =
"https://parkcast.onrender.com"` (app/build.gradle.kts:29; generated
BuildConfig.java:13) and seeded into SharedPreferences on first run (MainActivity.kt:100-102).
The page `player/index.html` loads exactly two same-origin scripts, `birthday.js` and
`player.js` (index.html:154-155), and nothing from any third-party origin. The player's
only network primitives are one same-origin `fetch('/api/player/register')` (player.js:153)
and one WebSocket to `location.host` (player.js:173); `birthday.js` is a pure canvas
renderer with zero network calls (verified: no `fetch`/`XMLHttpRequest`/`WebSocket`/URL
literals in the file). There are no analytics, ads, or third-party SDKs (see
SDK_DATA_AUDIT.md). The native layer contains **zero** `Log.*`/`println` calls (verified
by grep over `app/src/main`).

---

## 2. Data that PERSISTS on the TV device

| # | Item | Exact key | Written at | Content | Personal? | Deletable? |
|---|------|-----------|-----------|---------|-----------|-----------|
| P1 | Server address | SharedPreferences file `"parkcast"`, key `"serverUrl"` | MainActivity.kt:32 (file), 100-102 (default seed), 149 (operator edit via MENU dialog, 137-153) | URL of the venue's signage server (default `https://parkcast.onrender.com`) | No — infrastructure address entered by the operator | Yes: overwrite via MENU dialog; erased by app uninstall / Clear data |
| P2 | "Asked for boot permission" flag | SharedPreferences `"parkcast"`, key `"bootPermAsked"` | MainActivity.kt:113-114 | Boolean | No | Erased by uninstall / Clear data |
| P3 | TV identity | WebView localStorage key `"parkcast.tvId"` (legacy fallback `"skyzone.tvId"`, migrated on read) | player.js:27-28 (read/migrate), 160 (write after register); enabled by `domStorageEnabled = true` (MainActivity.kt:45) | Random UUIDv4 **generated server-side** (`crypto.randomUUID()`, server/src/index.js:585). Not derived from any hardware ID — no MAC, serial, IMEI, ANDROID_ID, or advertising ID is ever read anywhere in the app or page | Pseudonymous device/install identifier; identifies a signage appliance, not a person | Yes: cleared by the app on a server `reregister` push (player.js:191-203); server row deletable from dashboard (index.js:697-709); erased by uninstall / Clear data |
| P4 | WebView HTTP cache of media | WebView cache (standard) | Media URLs served with `maxAge: '365d', immutable` (server/src/index.js:329); loaded into `<video>/<img>` elements (player.js:377, 382, 433-436) | The venue's own uploaded signage media (videos/images) | Content is operator-controlled; could incidentally contain people/party imagery the venue uploaded | Erased by uninstall / Clear data; replaced files get fresh filenames (index.js:135-138) |

Not present (verified): no cookies are ever set by the server (`res.cookie`/`Set-Cookie`
appears nowhere in `server/src`; the `cookie` entries in package-lock.json are unused
transitive express deps), no databases, no files written by native code, no
SharedPreferences beyond the two keys above (MainActivity.kt is the only class touching
`prefs`; BootReceiver.kt touches no storage).

---

## 3. Data the TV SENDS off the device (all to the configured server only)

| # | Payload | Code | Exact fields | Frequency | Personal? |
|---|---------|------|--------------|-----------|-----------|
| S1 | Registration | `POST /api/player/register`, player.js:151-157 | JSON body: `{ existingId: <tvId or null> }` — nothing else | On boot; retried every 3 s until it succeeds (player.js:546-552) | Pseudonymous device ID only |
| S2 | WebSocket hello | player.js:185 (and re-hello after reregister, 199) | `{ type: 'hello', role: 'player', tvId }` | On each (re)connect | Same tvId |
| S3 | Playback status | player.js:217-225, `setInterval(reportStatus, 10000)` at 226 | `{ type: 'status', nowPlaying }` where `nowPlaying` is one of: `'Screen off'`, `` `Party: ${state.override.name}` `` (player.js:221), the current playlist item's `label` (222), or `'Idle'` (223) | Every 10 s and on each state change (player.js:274, 294, 402) | **See §5** — during a birthday takeover this string echoes the child's first name the server itself sent |
| S4 | Implicit protocol metadata | Any HTTP/WS request | IP address, WebView User-Agent (contains Android version and device model — standard WebView UA), TLS handshake data | Every request | IP is potentially personal in GDPR terms. Server-side it is used **only** in in-memory rate-limit maps with expiring windows (register: index.js:555-568; login: 295-310) and is never written to disk — there is no request/access logging in the application (verified: full `console.*` audit in DATA_SAFETY_AUDIT.md §6). The hosting platform (Render) may keep its own edge logs — outside app code |

That is the complete outbound surface. The page makes no other `fetch`, no beacons, no
third-party requests (all media/script/favicon URLs are same-origin relative paths —
index.html:7-8, 154-155; player.js resolves item URLs against `location.href`, 375, 431).

## 4. Data the TV RECEIVES and displays (server → TV; not "collection")

The single `state` message (built in server/src/index.js:208-264) contains:

- `tv: { id, name }` — the dashboard-assigned screen name ("TV 3"), shown on the idle screen (player.js:258).
- `pairCode` — 6-digit rotating pairing code, only while unclaimed (index.js:210-213; rotation every 15 min at index.js:610, 618-624). Displayed full-screen (player.js:270).
- `playlist[]` — items `{ id, label, url, type, durationSec, slide?, comp? }` (index.js:184-206).
- `override` — birthday/event takeover: `{ name, message, mediaUrl, endsAt, msRemaining, theme, themeSpec }` (index.js:249-259).
- `venueName`, `power`, `fit`, `transition` (index.js:261-263).
- Media bytes for the above URLs (`/media/...`, index.js:329).

**Children's first names and ages** arrive inside `override`:

- `override.name` — the birthday child's first name (up to 3 words / 40 chars from the
  byline parser, byline.js:51-68; up to 60 chars from the test endpoint, index.js:744).
  Rendered as the animated headline (player.js:478, 251) and echoed in S3 above.
- The **numeric age field is never sent to the TV** — verified: the `override` object
  assembled at index.js:249-259 has no `age` key. However, the age is embedded in the
  default `message` **text**: `` `Happy ${ordinal(ev.age)} Birthday, ${ev.name}!` ``
  (byline.js:77-81, used at scheduler.js:34 and index.js:1384), so an age like "10th"
  is visible in the displayed/received string.

Origin of these names/ages: typed by venue staff in the dashboard, imported from a
bookings CSV, or parsed from ROLLER booking bylines (index.js:1265-1299 create,
1320-1336 edit, 1505-1537 import; parser in byline.js) — always operator-side input
about a third party (the party child), never captured from anyone at the TV.

## 5. Are the displayed children's names "collection" by the app in Play terms?

Google's Data safety definition: data is **"collected"** when the app **transmits it off
the device**; on-device display alone is out of scope, and "shared" means transfer to a
*third party*.

**Case that it is NOT collection (recommended position):**
1. The names/ages travel *to* the device, not from it. The app gathers nothing from
   viewers: no camera, microphone, location, contacts, input fields, or sensors exist
   anywhere in the app (MainActivity.kt has no such API call; the page has no form).
2. The one off-device transmission containing a name — `nowPlaying: "Party: Nathan"`
   (player.js:221) — is a verbatim echo of a string fragment the *same server* pushed
   moments earlier (index.js:250). The server learns nothing it did not already hold;
   no new data about any person is acquired by anyone. Play's collection concept targets
   *user data acquired from the user/device*; content metadata delivered by the
   operator's own backend and reflected back to that backend is analogous to a video
   player reporting "now playing: <title>".
3. The data subject (the party child) is not a user of the app, and the recipient is the
   data controller (the venue) on its own server — there is no third party anywhere.

**Case that it IS collection (strict reading):**
1. Literally, a child's first name is transmitted off the device by the app (player.js:221).
   A maximally literal reviewer could call that "Personal info → Name, collected".
2. Play's automated traffic analysis could observe a name-like string leaving the device
   and flag a mismatch with a "no data collected" form.

**Recommendation (defensible):** declare **no Name collection** — the echo adds no
information and the data subject is not a user — **and** remove the echo anyway so the
wire matches the form with no argument needed: change player.js:221 to report a neutral
marker (e.g. `nowPlaying = 'Party'`); the dashboard already knows which party is active
from its own `tv.override` state (index.js:232-259 / dashboardSnapshot). Until that change
lands, the privacy policy's sentence "Neither identifies any person"
(server/public/privacy.html:39-40) is not strictly accurate for the status message during
a takeover — fix one or the other before submission (see DATA_SAFETY_AUDIT.md,
code change #1).

## 6. Retention (server side, for the data the TV sent)

- TV row (`id`, `name`, `createdAt`, `lastSeen`, `nowPlaying`, …): persisted in
  `db.json` (store.js:8, index.js:1620-1632, heartbeat write-throttled at 1629-1631).
  Deleted when an owner deletes the screen (index.js:697-709, owner-only) or, if never
  claimed, expired automatically after 24 h without heartbeat (index.js:611, 617).
- `nowPlaying` is a single overwritten field (index.js:1624-1626), not a history log.
- Party/event rows (with child name + age) are operator data: deletable one-by-one
  (index.js:1404) or in bulk for finished parties (index.js:1432). There is **no
  automatic purge** of done events (scheduler.js only flips `status`, 21/46) — noted as a
  server-side hygiene item, outside the Play app's disclosure surface.

## 7. Play Data Safety disclosure map (summary — full form in DATA_SAFETY_AUDIT.md)

| Data | Play category | Disclose as collected? |
|------|--------------|------------------------|
| tvId (S1-S3) | Device or other IDs | **Yes (conservative recommendation)** — app functionality, not shared, not optional; see DATA_SAFETY_AUDIT.md §2 for the two positions |
| serverUrl, bootPermAsked | — | No (never leaves the device except as the connection target itself) |
| nowPlaying status | App activity (app interactions) at most | No, if the name echo is removed; borderline otherwise (§5) |
| Children's names/ages displayed | — | No — received/displayed, not collected from users (§5) |
| IP / User-Agent | — | No — ephemeral, in-memory processing only (S4) |
