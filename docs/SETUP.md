# Skyzone TV — Complete Setup Guide

Everything to buy and every step to get all 12 TVs live. One-time effort:
about half a day. After that the daily routine is ~5 minutes
(see [RUNBOOK.md](RUNBOOK.md)).

---

## 1. What to buy (shopping list)

| Item | Qty | ~Price | Why |
|---|---|---|---|
| **Amazon Fire TV Stick 4K Max** | 12 | $60 ea → $720 | The player device. One per TV, plugs into HDMI. Fire TV allows installing our app in minutes (no app-store review), and a stick per TV means every TV behaves identically regardless of TV brand. |
| **Beelink Mini S12 Pro (or similar mini PC, 16GB/500GB)** | 1 | ~$180 | Runs the server 24/7 at the park. Sits in the office/network closet, wired into the router. |
| **Ethernet cable** for the mini PC | 1 | $10 | The server should be wired, not on Wi-Fi. |
| **USB power adapters/extensions** (if a TV has no free outlet nearby) | as needed | ~$10 ea | Fire TV sticks need wall power for 24/7 use — don't power them from the TV's USB port (it turns off with the TV input). |
| **Fully Kiosk Browser PLUS license** (optional but recommended) | 12 | $8.90 ea → ~$107 | The kiosk app that runs our player full screen, auto-starts on boot, and auto-relaunches if anything crashes. The free version works for testing; PLUS removes limits and adds remote management. |
| **Tailscale** (optional) | free | $0 | Lets your phone reach the dashboard from home/anywhere, without exposing anything to the internet. |

**Total: roughly $1,000–1,100 one-time, ~$0/month.**

Notes on the choice of platform:
- **Fire TV / Google TV (both are Android)** won the "quickest and smoothest"
  test: you can install the player on all 12 devices in an afternoon with no
  developer account, no certificates, and no app-store review.
- **Samsung Tizen** was rejected: it requires Tizen Studio on a PC, a Samsung
  developer certificate that expires and must be re-signed periodically, and a
  per-TV device-ID whitelist — much slower and more fragile for 12 screens.
- If you'd rather use **onn. Google TV 4K boxes** ($20 at Walmart) instead of
  Fire Sticks, everything below works the same — they're also Android and also
  run Fully Kiosk. Fire TV Stick 4K Max is recommended for its faster remote
  management and better Wi-Fi.

Requirements from the park: Wi-Fi (or Ethernet drops) that reaches all 12 TVs,
and one power outlet near each TV for the stick.

---

## 2. Set up the server (once, ~30 minutes)

The server is one Node.js app. It stores your media and settings in
`server/data/` (plain files — easy to back up).

On the mini PC (Windows or Linux both work):

1. Install [Node.js LTS](https://nodejs.org) (v18 or newer).
2. Copy this repository onto the machine (`git clone` it, or download the ZIP
   from GitHub).
3. In a terminal:
   ```bash
   cd SkyzoneTV/server
   npm install
   npm start
   ```
4. The console prints the addresses and the dashboard password — write them
   down:
   ```
   Dashboard: http://192.168.1.50:8080/dashboard/
   Players:   http://192.168.1.50:8080/player/
   Dashboard password: 3f9c21ab  (auto-generated)
   ```
   A random password is generated on first start and kept from then on. To
   pick your own instead, set the `ADMIN_PASSWORD` environment variable before
   starting (`set ADMIN_PASSWORD=...` on Windows, `export ADMIN_PASSWORD=...`
   on Linux/Mac).
   (Your IP will differ. Give the mini PC a **static IP / DHCP reservation** in
   your router so this address never changes — this is important, the TVs
   remember it.)

   Also check the mini PC's **clock and timezone** are set to Chicago time —
   the CSV's party times are interpreted in the server's local timezone.
5. Open the dashboard address on your phone (same Wi-Fi) and log in.

### Make the server start on boot

- **Windows:** Task Scheduler → Create Task → trigger *At startup* → action
  *Start a program* → `node` with arguments `src/index.js`, start in
  `C:\...\SkyzoneTV\server`. Set "Run whether user is logged on or not".
- **Linux:** `sudo npm install -g pm2 && pm2 start src/index.js --name skyzone-tv && pm2 save && pm2 startup`
  (run the command `pm2 startup` prints).

### Optional: reach the dashboard from anywhere

Install [Tailscale](https://tailscale.com) (free) on the mini PC and on your
phone/laptop, sign both into the same account, and the dashboard is reachable
at the mini PC's Tailscale address from anywhere — with nothing exposed to the
public internet.

---

## 3. Set up each TV (~10 minutes per TV)

### If the TVs have Google TV built in (no stick needed)

If the park's TVs already run Google TV / Android TV (Google Play on the TV
itself), skip the Fire Sticks — install the player directly on each TV:

1. **Developer mode:** Settings → System → About → click **"Android TV OS
   build"** 7 times.
2. **Install Downloader:** Play Store on the TV → "**Downloader by AFTVnews**".
3. **Allow installs:** Settings → Apps → Security & Restrictions → **Unknown
   sources** → ON for Downloader.
4. **Install Fully Kiosk:** open Downloader → enter `fully-kiosk.com/go` →
   install the APK.
5. **Configure Fully Kiosk:** Start URL `http://YOUR-SERVER-IP:8080/player/`;
   Web Content Settings → **Autoplay Videos ON**; Device Management →
   **Launch on Boot ON**, **Keep Screen On ON** (grant what it asks).
6. **Stop the TV sleeping:** Settings → System → Power & Energy → "Turn off
   display" → longest/Never, and **Ambient mode / Screen saver → Off** so
   Google's screensaver never covers your media.
7. Rename the TV in the dashboard to its physical room.

### If the TVs are not smart / not Android: add a Fire TV Stick per TV

Repeat once per TV. You need: the Fire TV stick, its remote, the park Wi-Fi
password, and the server address from step 2.

1. **Plug in** the stick to the TV's HDMI and to wall power. Go through
   Amazon's first-boot setup, join the park Wi-Fi.
2. **TV settings** (on the TV itself, once): set the TV to auto-select the
   stick's HDMI input on power-on, and turn on HDMI-CEC (Samsung calls it
   *Anynet+*) so the stick wakes the TV.
3. **Fire TV settings:**
   - Settings → My Fire TV → Developer Options → **Apps from Unknown Sources: ON**.
     (If Developer Options is hidden: Settings → My Fire TV → About → click the
     device name 7 times.)
   - Settings → Preferences → Screen Saver → set to **Never** / longest, so the
     screensaver never covers your media.
4. **Install Fully Kiosk Browser:** search "**Downloader**" in the Fire TV app
   store, install it, open it, and enter `fully-kiosk.com/go` — install the
   downloaded APK.
5. **Configure Fully Kiosk** (Settings inside the app):
   - **Start URL:** `http://YOUR-SERVER-IP:8080/player/`
   - Web Content Settings → **Autoplay Videos: ON**, Autoplay Audio: ON if you
     want sound (add `?audio=1` to the Start URL too).
   - Device Management → **Launch on Boot: ON**, **Keep Screen On: ON**.
   - Advanced Web Settings → Fake User Agent: leave default.
   - Kiosk mode (PLUS): optional — locks the remote so staff can't exit.
6. The TV now shows the Skyzone idle screen with a name like "**TV 5**".
   On the dashboard, click that name and rename it to the physical location —
   e.g. **Room 1**, **Main Court**, **Front Desk**. (These names are what your
   birthday CSV matches against.)

That's it — the TV is permanently set up. It reconnects and resumes by itself
after power cuts, Wi-Fi drops, and server restarts.

### Optional: the native Android app instead of Fully Kiosk

`android-player/` is a tiny native Android TV app (a full-screen wrapper around
the same player) if you prefer an installed "Skyzone TV Player" app over Fully
Kiosk. Open the folder in Android Studio → Build → Build APK, then install the
APK on each stick with the same Downloader method (host the APK file anywhere
on your network) or `adb install`. On first launch it asks for the server
address; press ☰ (menu) on the remote to change it later. Fully Kiosk is
recommended to start — it's faster to deploy and adds crash-recovery and
remote-management features.

---

## 4. Load your media and test

1. Dashboard → **Media** tab → **Upload MP4** (or drag & drop). Use H.264 MP4s —
   1080p is plenty. Everything you upload is stored on the server and listed
   with a label you can rename (labels are also what the CSV `media` column
   matches).
2. Try the two included files in `sample-media/`:
   `skyzone-test-loop.mp4` (test pattern) and `birthday-loop.mp4` (birthday
   background).
3. Click **Set as birthday** on your birthday video — it becomes the default
   background for every birthday takeover.
4. **TVs** tab → each TV card → **Media…** → check the videos it should loop
   (numbers show play order), Save. Or use **Set playlist for ALL TVs…** /
   **Apply to all TVs** to push one loop everywhere.
5. Click **🎂 Test** on any TV card, type a name — that TV (and only that TV)
   plays the birthday takeover for 1 minute, then returns to its loop.

---

## 5. Birthday parties from a CSV

Export or type the day's parties into a CSV
(see [CSV-FORMAT.md](CSV-FORMAT.md), sample in the dashboard):

```csv
date,time,tv,name,message,duration,media
2026-08-13,10:30,Room 1,Aiden,,5,
2026-08-13,11:00,Room 2,Maya,Happy 8th Birthday Maya!,5,Birthday Loop
```

Dashboard → **Events** tab → **Upload events CSV**. The dashboard confirms how
many events imported and flags any row it couldn't understand (bad time, TV
name that doesn't match, etc.). At each start time, the matching TV switches to
the birthday screen with the kid's name for the given minutes (default 5),
then reverts automatically. Every other TV is untouched. You can also add
one-off events by hand (**+ Add event**) or fire one early (**Start now**).

---

## 6. Security notes

- The dashboard password is auto-generated on first start (no well-known
  default). Set the `ADMIN_PASSWORD` environment variable if you want to
  choose your own.
- Everything runs on your local network only. The player pages on the TVs are
  unauthenticated (they only *receive* media); the dashboard (anything that
  *changes* things) requires the password. If guests use the same Wi-Fi,
  consider putting the TVs + server on a separate staff/IoT network.
- Back up `server/data/` occasionally — it contains all uploaded media and
  settings.
