# ParkCast Player — Play Console Data Safety Audit & Form Answers

Audit date: 2026-09-21, re-verified the same day against v1.3.1 / versionCode 6
(commits 48d305c and 9693c6f changed MainActivity, the manifest's leanback flag, and
strings — none of it altered the data surface; the logging grep was re-run clean).
Companion documents: PRIVACY_DATA_INVENTORY.md (traced data
flows), PERMISSION_AUDIT.md, SDK_DATA_AUDIT.md, SECRET_AUDIT.md. Every answer below is
grounded in code read during this audit; file:line references are given where the answer
depends on them.

---

## 1. The complete outbound surface (basis for every answer)

The app transmits exactly three payloads, all to the operator-configured signage server
and nothing else (PRIVACY_DATA_INVENTORY.md §3): a random server-issued screen UUID at
registration (player.js:151-157) and in the WebSocket hello (player.js:185), and a
10-second playback-status string (player.js:217-226). No third-party endpoint, SDK, ad
ID, or analytics exists (SDK_DATA_AUDIT.md). On-device persistence is the server URL, a
boolean, the UUID, and the WebView media cache (PRIVACY_DATA_INVENTORY.md §2).

## 2. Question-by-question form answers

### "Does your app collect or share any of the required user data types?"

**Answer: Yes** (conservative recommendation — see the deliberation below).

The defensible minimal declaration is a single data type: **Device or other IDs**,
collected, not shared. Two positions were weighed:

- *Declare nothing* (the position an earlier revision of docs/STORE-PUBLISHING.md took):
  the tvId is a random, server-generated, app-scoped UUID naming a signage appliance;
  it relates to no person and Play's form is about *user* data. Many signage apps
  declare nothing. Risk: Play's published definition of "collected" is simply "user
  data transmitted off the device", and "Device or other IDs" is defined broadly
  ("identifiers that relate to an individual device…"). An automated traffic check sees
  a persistent identifier leaving the device; a mismatch flag against a "collects
  nothing" form is a listing-rejection risk that buys nothing.
- *Declare Device or other IDs* (recommended): honest under the broad definition, costs
  one row in the form, matches the privacy policy (privacy.html:33-40 already discloses
  the identifier), and immunizes against mismatch review.

Status: docs/STORE-PUBLISHING.md has since been corrected by the release-process audit
and now instructs exactly this declaration ("Device or other IDs — collected, not
shared…", STORE-PUBLISHING.md:56-60, verified 2026-09-21). The two documents agree.

### Per-category answers (the form's full category walk)

| Play category | Collected? | Shared? | Justification (verified) |
|---|---|---|---|
| Location (approx/precise) | **No** | No | No location API anywhere; no location permission (PERMISSION_AUDIT.md §4) |
| Personal info (name, email, address, phone, etc.) | **No** | No | Nothing is gathered from any user. Children's names/ages are *received and displayed*, not collected — full both-ways analysis in PRIVACY_DATA_INVENTORY.md §5. Precondition for a clean "No": remove the `"Party: <name>"` status echo (player.js:221) — code change #1 below |
| Financial info | **No** | No | Nothing exists |
| Health & fitness | **No** | No | Nothing exists |
| Messages | **No** | No | Nothing exists |
| Photos & videos | **No** | No | The app *plays* venue media; it never reads the device's photos/videos (no storage permission) |
| Audio files / Music | **No** | No | Same |
| Files & docs | **No** | No | Same |
| Calendar | **No** | No | Nothing exists |
| Contacts | **No** | No | Nothing exists |
| App activity | **No** (defensible) | No | The `nowPlaying` heartbeat describes what the *screen* shows, pushed by the same server it reports to; it is service telemetry about the appliance, not user interaction data (no user interacts with the TV app beyond the server-address dialog and the new triple-BACK exit dialog — MainActivity.kt:160-176 stores the URL locally only; the exit flow, 189-222, transmits nothing) |
| Web browsing | **No** | No | Kiosk WebView pinned to one page; no browsing |
| App info & performance (crash logs, diagnostics) | **No** | No | No crash reporter, no diagnostics upload (SDK_DATA_AUDIT.md §1); renderer crashes self-heal locally (MainActivity.kt:94-99) |
| **Device or other IDs** | **Yes** | **No** | The random screen UUID (player.js:27-28, 160, 185; issued at server/src/index.js:585). Purpose: **App functionality** (letting the venue's dashboard tell its own screens apart). Optional? **No** (required for the app's function). Shared with third parties? **No** — it goes only to the server the operator configures, i.e. the venue's own service (first party / service provider) |

### "Is all of the user data collected by your app encrypted in transit?"

**Honest analysis — do not gloss this:**

- The Play-distributed configuration talks HTTPS+WSS to `parkcast.onrender.com`:
  `DEFAULT_SERVER_URL` is `https://` (app/build.gradle.kts:30), and the page upgrades
  the socket to `wss` whenever the page is https (player.js:171).
- BUT `android:usesCleartextTraffic="true"` is set (AndroidManifest.xml:19), the
  address dialog hints a plain-HTTP LAN address (`http://192.168.1.50:8080`,
  strings.xml:13 via MainActivity.kt:162), and `playerUrl()` prepends `http://` when no
  scheme is typed (MainActivity.kt:154). An operator running the self-hosted LAN mode transmits the
  UUID + status unencrypted **on their own network to their own server**.

Recommended answer: **Yes**, with this rationale kept on file: every transmission in the
configuration Play distributes is TLS; cleartext occurs only when the venue operator
deliberately reconfigures the app to their own on-premises server, where the data
(a random UUID and a playback string) never leaves the operator's private network and
the operator is the recipient. If reviewers are stricter, the fallback is answering
"No" — which for a Device-ID-only declaration is survivable but ugly — or shipping
code change #4 (scheme-aware hardening) first. This is a judgment call listed under
MANUAL VERIFICATION; do not treat this document as settling it silently.

*(Note: Android network security config cannot whitelist cleartext by IP range, only by
domain, so "cleartext for RFC1918 only" is not implementable as pure config; LAN mode
genuinely needs cleartext capability.)*

### "Do you provide a way for users to request that their data is deleted?"

**Answer: Yes.**
- On-device: uninstall/Clear data removes everything (SharedPreferences + localStorage
  + cache — PRIVACY_DATA_INVENTORY.md §2).
- Server-side: the venue owner deletes a screen from the dashboard, which removes the
  row including the UUID and nowPlaying (server/src/index.js:697-709); unclaimed screens
  auto-expire after 24 h (index.js:611, 617). The privacy policy commits to deletion
  requests within 30 days with a contact address (privacy.html:56-62, 74).

### Ephemeral-processing option

The form allows marking data "processed ephemerally" to avoid declaring it. Applies to:
**IP addresses** (in-memory rate-limit maps with expiring windows only,
index.js:555-568, 295-310; never written to disk; no access log in app code) — this is
why IP is not declared. Does **not** apply to the tvId (persisted in `db.json`,
store.js:8, and in device localStorage), so the Device-ID declaration cannot use it.

### Data collected via third-party SDKs / libraries

**None** — two AndroidX libraries only (SDK_DATA_AUDIT.md §1).

### Ads / Advertising ID

**No ads. No AD_ID permission in the merged manifest** (PERMISSION_AUDIT.md §4).
Declare "app does not use advertising ID" — consistent with targeting API 33+ rules.

### Target audience & children (Families policies)

Target audience: **18+ / not designed for children**. The app is a B2B operator tool;
its *users* are venue staff. Children appear only as *subjects displayed on screens* in
physical venues, which does not make the app child-directed under Play's Families
policy (the app has no interaction surface for viewers at all). Do not tick any
child-appeal boxes; docs/STORE-PUBLISHING.md:63-65 already says the same.

### Data Safety vs. the privacy policy (consistency check)

privacy.html:33-40 discloses exactly the two transmissions this audit found (identifier
+ playback status) — good. **One inaccuracy**: "Neither identifies any person"
(privacy.html:39-40) is false while player.js:221 echoes `"Party: <child's first
name>"` in the status. Ship code change #1 (or reword the policy) before submission so
form, policy, and wire agree.

---

## 3. Account deletion requirement (Play's account-deletion policy)

**TV app: N/A — and document why.** Play's requirement applies to apps that "allow
users to create an account". ParkCast Player has no account creation, no login, no
sign-in UI of any kind: the entire native surface is a server-address dialog, a
one-time permission dialog, and an exit-confirmation dialog (MainActivity.kt:133-176,
213-222); the player page pairs by showing a code
(player.js:267-276) and authenticates nothing (server treats players as unauthenticated
by design, index.js:47, 570-604). In the Play Console "Account deletion" question,
answer that the app does not allow account creation. The pairing code is not an
account: it is a rotating (15-min, index.js:610, 618-624), server-generated claim token
displayed on screen, holding no user data.

**Web dashboard (out of Play scope, but the gap is real):** accounts exist there —
email + scrypt-hashed password (index.js:51-62, 391-399), 30-day expiring sessions
(index.js:64, 88-92), server-side logout (index.js:428-433), owner/staff roles
(index.js:112-116, 493). Deletion today: an **owner can delete other members**
(index.js:524-532) with immediate session revocation (index.js:465-470), but
**owners cannot delete themselves** (index.js:527: "You cannot remove yourself") and
there is **no self-service account deletion or venue deletion** — an owner wanting out
must email the operator contact. Since the dashboard is a website, Play's policy does
not bite, but GDPR/CCPA erasure duties and basic hygiene do. Eventually the web product
needs: (a) self-service owner account deletion with a last-owner/venue-teardown flow,
(b) a documented erasure path for venue data (events with children's names, media,
users), and (c) automatic purging of `status: 'done'` events after a retention window —
today they persist until manually cleared (index.js:1432; scheduler.js only flips
status, never deletes).

---

## 4. Logging audit (grep-verified)

| Where | Result |
|-------|--------|
| `MainActivity.kt`, `BootReceiver.kt` | **Zero** `Log.*` / `println` / `System.out` calls (grep over `app/src/main`: no matches). Nothing to remove |
| `player.js`, `birthday.js`, `player/index.html` | **Zero** `console.*` calls. Pairing codes, tvId, names — never logged |
| `dashboard/app.js`, `dashboard/index.html` | **Zero** `console.*` calls in first-party code. The session token lives in `localStorage['parkcast.token']` (app.js:6-7, 124) but is never logged |
| `vendor/html2canvas.min.js` | Contains internal `console` usage (vendored lib, operator browser only, logs rendering diagnostics — no ParkCast data). Acceptable |
| Server `src/` | `console.error(err)` for 500s (index.js:1576 — stack traces, no credentials); startup banners (index.js:1675-1680); roller sync errors (roller.js:116 — error messages only); db warnings (store.js:33, 94). **One finding: index.js:1681-1682 prints `ADMIN_PASSWORD` to stdout at every startup** — on Render this puts the live admin password into retained platform logs. Should be removed/masked for cloud deploys (code change #2). Note: server logs are outside the app's Data-safety scope but inside the venue's real-world risk |

No log statement anywhere emits tokens, pairing codes, emails, or password material
besides the ADMIN_PASSWORD startup banner above.

---

## 5. (a) Numbered code changes needed, ranked by risk (none applied — audit is read-only)

1. **HIGH — stop echoing the child's name off-device.**
   `server/public/player/player.js:221`: change
   `nowPlaying = \`Party: ${state.override.name}\`` to a neutral constant (e.g.
   `'Party'`). The dashboard already knows the active party from its own state
   (server/src/index.js:232-259). This makes "no Personal info collected" and the
   privacy policy's "Neither identifies any person" (privacy.html:39-40) literally true
   on the wire. Alternative if the name must stay: reword privacy.html instead.
2. **HIGH (operational, not Play) — stop printing the admin password to cloud logs.**
   `server/src/index.js:1681-1682`: print the value only when it was auto-generated
   this boot (or mask when `process.env.ADMIN_PASSWORD` is set).
3. **HIGH (release process, already flagged) — rotate the exposed upload key.**
   Not a source change: Play App Signing enrollment + upload-key reset per
   docs/STORE-PUBLISHING.md:12-21; the old key/passwords remain extractable from
   commits `7834ba9`..`ebf2f34^` (SECRET_AUDIT.md §1).
4. **MEDIUM — tighten the cleartext story before answering "encrypted in transit: Yes".**
   Options, cheapest first: leave `usesCleartextTraffic` (AndroidManifest.xml:19) but
   change the address-dialog default-scheme prepend from `http://` to `https://`
   (`MainActivity.kt:154`) and the hint text (`strings.xml:13`, `setup_hint`) so
   cleartext only happens when an operator *types* `http://` deliberately; document the
   LAN exception in the console notes. (IP-range cleartext whitelisting is not
   supported by Android network security config, so full removal breaks LAN mode.)
5. **LOW — server hygiene: auto-purge `done` events** after a retention window
   (children's names/ages otherwise persist in db.json until an operator clears them —
   index.js:1432, scheduler.js:21/46).

*(Resolved since first draft: docs/STORE-PUBLISHING.md's stale "no data collected"
guidance was corrected by the release-process audit — it now matches this document's
Device-ID declaration and the `/privacy` URL, STORE-PUBLISHING.md:53-61.)*

## 6. (b) The 5 most important Data Safety form answers

1. **Data collected: Yes — exactly one type: Device or other IDs** (the random screen
   UUID; purpose App functionality; required, not optional). Nothing else.
2. **Data shared with third parties: No** — every transmission goes solely to the
   venue-configured first-party server; no SDKs, no ads, no analytics.
3. **Encrypted in transit: Yes** (Play-distributed default is HTTPS/WSS to
   parkcast.onrender.com), with the LAN-cleartext rationale kept on file — see §2; this
   is the one answer with a documented judgment call.
4. **Deletion: Yes** — dashboard screen deletion removes the server-side ID
   (index.js:697-709), uninstall removes everything on-device, policy commits to
   30-day request handling (privacy.html:56-62).
5. **Account creation: none in the app** → account-deletion requirement N/A; target
   audience 18+/not child-directed; no Personal info (incl. children's names) is
   *collected* — they are operator-entered content displayed on screens, with the
   status-echo removal (change #1) closing the only literal counter-argument.

## 7. (c) MANUAL VERIFICATION items (cannot be verified from this repo)

1. **Live TLS check:** confirm `https://parkcast.onrender.com/player/` and
   `wss://parkcast.onrender.com/ws` actually serve valid TLS in production, and that
   `REQUIRE_TV_APPROVAL=1` is set on the Render service (render.yaml declares it, but
   the dashboard env is the source of truth).
2. **Privacy policy URL reachability + contact:** `https://parkcast.onrender.com/privacy`
   must be live at submission time, and the contact `srini.vanukuri@gmail.com`
   (privacy.html:74) must match/forward to the Play Console developer contact. Confirm
   "UnlimitedFun LLC" (privacy.html:22) exactly matches the Play organization account
   name and its D-U-N-S verification.
3. **Decide the two judgment calls on record:** (i) declare Device IDs vs. declare
   nothing (§2 — this audit recommends declaring); (ii) encrypted-in-transit Yes with
   LAN rationale vs. shipping change #4 first. Both need a human owner sign-off.
4. **Upload-key rotation completion:** after Play App Signing enrollment, verify the
   upload-key reset was executed and the new keystore lives only in a password manager
   (SECRET_AUDIT.md §1 — history still contains the old key).
5. **Traffic capture on real hardware:** run the store build on a Fire TV/Google TV
   box with a proxy (e.g. mitmproxy) for 30+ minutes including a test birthday
   (dashboard → Test), and confirm the only host contacted is the configured server and
   the only payloads are the three documented ones — the ground-truth check Play's own
   scanners approximate.
6. **Old service decommission:** `skyzone-tv.onrender.com` still exists with live data
   until cutover (ops/venues.json note) — confirm it is deleted or covered by the same
   policy once TVs are re-pointed.
7. **Render platform logging:** confirm what Render retains (request logs may include
   TV IPs; stdout retains the ADMIN_PASSWORD banner until change #2 ships) and that
   this is acceptable under the venue's own privacy commitments.
8. **Rebuild verification for v1.3.1:** the merged-manifest and generated-BuildConfig
   checks in these audits were made against the last built artifact (versionCode 5).
   After building the 1.3.1 (versionCode 6) release bundle, re-run
   `aapt2 dump badging`/`aapt dump permissions` and confirm the permission list is
   still exactly INTERNET, RECEIVE_BOOT_COMPLETED, SYSTEM_ALERT_WINDOW and that
   leanback is required (source manifest AndroidManifest.xml:13).
