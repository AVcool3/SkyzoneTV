# Skyzone TV — Schaumburg Park Signage System

A complete digital-signage system for the 12 TVs at Skyzone Schaumburg:

- **Web dashboard** (phone or laptop) — see every TV live, upload videos and
  photo slides into a media library, build **playlists** (mixes of media with
  per-slide timing, play toggles, and fade transitions), assign them per TV or
  to all TVs, and start/end the day with one button. Photos have an
  **Edit in Canva** shortcut for continued design work.
- **TV player** — runs full screen on each TV, loops its assigned playlist, and
  keeps playing even if the network hiccups. Each TV is independent: changing
  one never interrupts the other eleven.
- **Birthday/event engine** — upload a CSV of the day's parties; at each party's
  start time, that room's TV automatically shows a "Happy Birthday *Name*"
  takeover (confetti + your birthday video) for 5 minutes, then returns to its
  normal loop on its own.

```
┌─────────────┐   upload MP4s / CSV    ┌──────────────────┐    WebSocket    ┌──────────┐
│ Your phone/ │ ─────────────────────► │  Skyzone TV       │ ──────────────► │ TV 1..12 │
│ laptop      │   dashboard (web)      │  server (Node.js) │   push control  │ (player) │
└─────────────┘                        └──────────────────┘                 └──────────┘
```

## Repository layout

| Path | What it is |
|---|---|
| `server/` | The signage server: API, dashboard, TV player page, scheduler |
| `android-player/` | Optional native Android TV / Fire TV wrapper app (Android Studio project) |
| `sample-media/` | Test MP4s: a color-bar test loop and a birthday background loop |
| `docs/SETUP.md` | **Start here** — everything to buy and the full first-time setup |
| `docs/RUNBOOK.md` | The 5-minute daily routine (open, upload, CSV, close) |
| `docs/CSV-FORMAT.md` | The events CSV format with examples |

## Quick start (try it on a laptop in 2 minutes)

```bash
cd server
npm install
npm start
```

- Dashboard: http://localhost:8080/dashboard/  (the password is printed in the
  terminal on startup)
- Open http://localhost:8080/player/ in another browser window — it appears in
  the dashboard as "TV 1" instantly.
- Upload `sample-media/skyzone-test-loop.mp4`, click **Apply to all TVs**, and
  watch it play. Click **🎂 Test** on a TV card to preview the birthday takeover.

Full production setup (hardware list, per-TV install, network, autostart):
**[docs/SETUP.md](docs/SETUP.md)**.
