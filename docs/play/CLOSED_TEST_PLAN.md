# Closed Test Plan — ParkCast Player v1.3 (versionCode 5)

Track: Google Play **Closed testing** · Build: `app-release.aab` (v1.3 / 5)
Prereq: the same build has already passed a quick smoke on the **Internal
testing** track (installs from Play, pairs, plays).

---

## Does the 12-tester / 14-day rule apply to us? (read this first)

**This app is published from an ORGANIZATION account (UnlimitedFun LLC).**

- **Organization account (our case):** Google's mandatory closed-testing gate
  does **not** apply. Production access is available without a tester quota or
  a minimum test duration. This plan is therefore *recommended practice*, not
  a compliance requirement — run it because it is the cheapest place to catch
  TV-quality-review failures, not because Google forces it. If time is
  critical you may legitimately shorten it, but do not skip Days 1–3 and 8–10.

- **Personal account (if the app is ever moved, or you publish from one):**
  personal developer accounts created after **November 13, 2023** MUST run a
  closed test with at least **12 testers opted in continuously for 14 days**
  before they can apply for production access. Two traps:
  1. **The opt-out clock reset.** The 14 days must be *continuous* with the
     tester count at or above the minimum. If testers opt out (or their opt-in
     lapses) and the count dips below 12, progress toward the 14 days stalls —
     and you can effectively lose accumulated days. One bored tester
     unenrolling on day 13 can cost you a week.
  2. **The buffer.** Because of trap 1, never recruit exactly 12. Recruit
     **15–20 testers** so that ordinary attrition can't drop you under the
     line. Testers must opt in via the closed-track link AND keep the app
     installed; tell them explicitly not to unenroll or uninstall until you
     say so.
  After the 14 days, the Console's "Apply for production access"
  questionnaire opens — suggested honest answers are in
  [GOOGLE_PLAY_RELEASE_CHECKLIST.md](GOOGLE_PLAY_RELEASE_CHECKLIST.md) §8.

Tester logistics either way: create the closed track, add testers by email
list (Google accounts), send them the opt-in URL, then the Play Store link.
Testers need an Android TV / Google TV / Fire TV-class device for a
meaningful test; a phone install only proves the APK parses.

---

## 14-day schedule

| Days | Phase | What happens |
|---|---|---|
| 1–3 | **Install, pair, primary flow** | Every tester installs from the closed-track Play link on a real TV device, pairs their screen, and confirms content plays. Goal: 100% of testers through the full tester script (below) at least once. Collect first-impression issues (focus, clipping, text size at 10 ft). |
| 4–7 | **Fix window** | Triage everything from days 1–3. Ship fixes as a new versionCode to the same closed track (testers auto-update). Keep the tester count stable — a new build does NOT reset the personal-account clock, but opt-outs do. |
| 8–10 | **Failure states** | Testers deliberately break things per script steps 5–8: pull network, reconnect, power-cycle the TV, kill/restart the server connection window. The app must always recover to playing content (or the branded "Connecting…" screen) with no human touching the remote. |
| 11–13 | **Regression pass** | Re-run the full tester script end-to-end on the latest build, including a fresh install on at least 2 devices (wipes SharedPreferences → exercises first-boot auto-connect + pairing again). Confirm every day-4–7 fix held. |
| 14+ | **Verify & write up** | Overnight soak ends; testers confirm content is still cycling after 24h+ unattended. Fill in CLOSED_TEST_REPORT.md (template below). Org account: promote to production when the report is clean. Personal account: keep the track running until the Console shows the 14-day/12-tester requirement met, then apply for production access. |

---

## Tester script (send this to every tester verbatim)

You need: an Android TV / Google TV / Fire TV device, its remote, and a
laptop or phone for the dashboard. You will be given a dashboard sign-in for a
test workspace at `https://parkcast.onrender.com/dashboard/` (or ask the
operator to do the dashboard steps while you watch the TV).

1. **Install & launch.** Opt in via the test link, install "ParkCast Player"
   from the Play Store on the TV device, and open it from the TV launcher row.
2. **Pairing code appears.** Within a few seconds the screen should show the
   ParkCast logo and a 6-digit code (e.g. "Code 483920") with the hint
   "Open your ParkCast dashboard, press "+ Add screen", and type in this
   code." No setup screen, no URL prompt, no browser error page. Note: the
   code rotates every ~15 minutes — always read it fresh off the TV.
3. **Operator claims the screen.** In the dashboard (Screens tab) press
   **"+ Add screen"**, type the code from the TV. The TV should appear as a
   new screen card within seconds.
4. **Content plays.** On the new screen card press **"Content…"** and assign
   the test playlist. The TV must start playing it full-screen — videos with
   no visible player controls, photo slides advancing on their timing, fade
   transitions if the playlist uses them.
5. **Unplug network.** Pull the Ethernet cable or kill the Wi-Fi. Expected:
   playback of already-loaded content continues, or the branded black
   "PARKCAST / Connecting…" screen appears. What must NOT appear: a gray/white
   stock browser error page, or an exited app.
6. **Reconnect.** Restore the network. Expected: the player returns to the
   assigned playlist by itself within ~30 seconds. Do not touch the remote.
7. **Restart the TV.** Power-cycle the device at the wall (not just the
   remote's standby). Expected: after boot, ParkCast Player relaunches by
   itself (if you granted "Display over other apps" when the app asked) and
   resumes the playlist. If you declined that permission, launching it
   manually once from the launcher must also resume the playlist.
8. **Leave idle overnight.** Leave the TV on with the playlist assigned
   overnight (12h+). Next morning, **verify content is still cycling** — not
   frozen on one frame, not a white screen, not the connecting screen while
   the network is up.
9. **Report focus/clipping issues.** While it runs, watch for TV-specific
   defects and report every one: text or media cut off at the screen edges
   (overscan clipping), D-pad focus getting lost in the server-address dialog
   (press MENU to open it, move focus with the D-pad, then Cancel), fonts too
   small to read from a couch, or any moment where a remote button press does
   something surprising. BACK is *supposed* to do nothing — that is kiosk
   behavior, not a bug.

Report every finding — even "it worked" — using the evidence format below.
Do not unenroll from the test or uninstall the app until the coordinator
says the test is over.

---

## Evidence-keeping

Keep one file, `docs/play/CLOSED_TEST_REPORT.md` (create it from the template
below; do not overwrite this plan). Evidence rules:

- One row per tester per script run — date, device model, OS, build tested.
- Photos of the TV (phone photos are fine) for: the pairing screen, content
  playing, and any defect. File them in a shared folder and link the folder
  from the report.
- Keep the Play Console numbers: closed-track opt-in count over time
  (screenshot the testers page weekly — this is your proof for the
  personal-account gate and useful color for the production-access
  questionnaire either way), pre-launch report results, and crash/ANR stats
  (Monitor and improve → Android vitals).
- Every defect gets an ID (CT-1, CT-2, …), a severity, and a resolution
  (fixed in versionCode N / won't fix + why).

### CLOSED_TEST_REPORT.md template (copy from here)

```markdown
# Closed Test Report — ParkCast Player

Test window: <start date> → <end date>
Builds tested: v1.3 (5)<, v1.3.1 (6), …>
Track opt-in peak / minimum: <n> / <n> testers
Evidence folder: <link>

## Testers & devices

| Tester | Device (model, OS) | Days 1–3 run | Days 8–10 run | Days 11–13 run | Overnight soak |
|---|---|---|---|---|---|
| <name> | <e.g. onn 4K (2023), Android TV 12> | pass/fail + date | pass/fail + date | pass/fail + date | pass/fail + date |

## Script step results (latest build)

| # | Step | Result | Notes |
|---|---|---|---|
| 1 | Install & launch | | |
| 2 | Pairing code appears | | |
| 3 | Claim from dashboard | | |
| 4 | Content plays | | |
| 5 | Network unplugged | | |
| 6 | Network reconnect | | |
| 7 | TV restart / auto-relaunch | | |
| 8 | Overnight idle, still cycling | | |
| 9 | Focus/clipping review | | |

## Defects

| ID | Severity | Found (day/build) | Description | Resolution |
|---|---|---|---|---|
| CT-1 | | | | fixed in vC <n> / won't fix: <why> |

## Feedback summary & changes made
<3–6 bullets — this text feeds the production-access questionnaire verbatim>

## Go/no-go
<date, decision, who decided>
```
