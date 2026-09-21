# Google Reviewer Instructions (App access) — ParkCast Player

This file has two parts: (A) what the owner must set up **before** submitting,
and (B) the exact text to paste into Play Console → **Policy → App content →
App access**.

The app itself has **no login**. It is a TV signage player: on launch it shows
a 6-digit pairing code, and an operator claims the screen from a web
dashboard. The reviewer therefore needs a dashboard account to see full
functionality — that account's credentials go in App access.

---

## A. Owner setup (do all of this before submission)

1. **Create the permanent reviewer account.** In the ParkCast dashboard at
   `https://parkcast.onrender.com/dashboard/#signup`, sign up a dedicated
   account (its own workspace, e.g. venue name "Play Review"). Use an email
   you control (e.g. a `+playreview` alias) and a strong password you will
   never rotate. Record them somewhere durable — Google re-reviews published
   apps for years using these exact credentials.
2. **Prepare the demo playlist.** Signed in as that account: upload 2–3 media
   items (e.g. `sample-media/parkcast-test-loop.mp4` plus a photo slide),
   create a playlist named **"Reviewer Demo"** containing them (Playlists tab
   → create → add media).
3. **Confirm the pairing flow is on.** The production server
   (`parkcast.onrender.com`) must run with `REQUIRE_TV_APPROVAL=1` so that a
   fresh TV shows a pairing code instead of auto-attaching to the default
   venue. If that env var is unset, the instructions below will not match what
   the reviewer sees — fix the env var, not the instructions.
4. **Confirm the service is awake and stays awake.** The Render service must
   respond at `https://parkcast.onrender.com` (service confirmation was still
   pending at the time of writing). A free-tier service that sleeps will show
   the reviewer the "Connecting…" screen for 30+ seconds or fail outright —
   use a paid/always-on instance for the review window and beyond.
5. **Verify the whole flow yourself** on a real TV device, following part B
   word for word, signed in as the reviewer account, the day before you
   submit.
6. Replace `REVIEWER_EMAIL` / `REVIEWER_PASSWORD` in part B, then paste.

**Credential requirements (Google's rules — the setup above satisfies them,
keep it that way):**
- **Permanent**: the account must never expire, never be deleted, and the
  password must not rotate. Do not run cleanup scripts against this workspace.
- **Location-independent**: must work from any country/IP. ParkCast sign-in
  has no geo restrictions — do not add any.
- **No OTP / 2FA**: ParkCast sign-in is email + password only. Never add a
  second factor to this account.
- **No manual activation**: nothing on your side may need to approve, unlock,
  or wake anything for the login to work. (This is also why the server must
  not sleep and why the demo playlist is created in advance.)

---

## B. Paste into App access

> App access → "All or some functionality is restricted" → Add instructions.
> Put the credentials in the dedicated username/password fields and the steps
> in the instructions field.

```
ParkCast Player is a digital-signage player for Android TV. The TV app itself
has NO login and no in-app account creation. Full functionality is unlocked
by pairing the TV to a venue dashboard on the web, using the account below.

Dashboard URL: https://parkcast.onrender.com/dashboard/
Username (email): REVIEWER_EMAIL
Password: REVIEWER_PASSWORD
(Permanent account. Works from any location. No OTP/2FA. No activation
needed on our side.)

Steps to see full functionality:
1. Launch ParkCast Player on the Android TV device. Within a few seconds it
   shows a 6-digit pairing code (e.g. "Code 483920"). No input is needed on
   the TV. (The code rotates every ~15 minutes — use the code currently on
   screen.)
2. On a computer or phone browser, open https://parkcast.onrender.com/dashboard/
   and sign in with the credentials above.
3. On the "Screens" tab, press the "+ Add screen" button and enter the
   6-digit code shown on the TV.
4. The TV appears as a new screen card. Press "Content…" on that card and
   select the playlist named "Reviewer Demo".
5. Expected result: the demo media (video and image slides) begins playing
   full-screen on the TV in a continuous loop within a few seconds.

Without signing in (the unauthenticated surface): the pairing-code screen in
step 1 IS the app's complete functionality for an unpaired TV — there is no
other screen, menu, or content behind it. Pressing MENU on the remote opens
the only other UI, a server-address dialog for self-hosted deployments
(Cancel closes it). BACK is intentionally ignored: this is a kiosk app for
unattended venue screens.

Notes for review:
- "Display over other apps" permission: requested once so the player can
  relaunch itself after a power cut on an unattended venue TV. Declining it
  only disables auto-relaunch.
- The app is a device client for the operator's own signage service (device
  pairing, kiosk behavior, boot recovery, offline retry) — not a wrapper
  around a public website.
```

---

## C. No-login fallback (if credentials cannot be used)

If a review pass evaluates the app without the dashboard: the app is still
fully functional as shipped — it boots straight to its pairing screen, which
is the entire unauthenticated surface by design (a signage TV has nothing to
show until a venue claims it). There are no dead ends, no crashes, and no
hidden functionality: pairing screen + MENU server dialog is 100% of the
on-TV UI. State this in any appeal/reply if a rejection claims the app "does
nothing": full functionality requires the venue dashboard, and working
credentials for it are provided in App access.
