# Go-live at the park

The concrete sequence to take this from "works on my laptop" to running on
every TV at Skyzone Schaumburg. Assumes the laptop is the server (works fine —
see the mini PC upgrade at the bottom for later).

## Phase 1 — server at the park (30 min, once)

1. Bring the laptop to the park, join the park's staff Wi-Fi.
2. Ask whoever runs the network for a **DHCP reservation** (static IP) for the
   laptop — this is the one non-negotiable: all TVs remember the server by IP.
3. Start the server so the laptop can't sleep on it:
   ```bash
   cd SkyzoneTV/server
   caffeinate -s npm start
   ```
4. Note the printed network address and dashboard password. Bookmark
   `http://THE-IP:8080/dashboard/` on your phone.

## Phase 2 — TVs (10 min each)

For each TV, either use its built-in Google TV or plug in an onn box, then
follow the per-TV steps in [SETUP.md](SETUP.md) (Downloader →
`http://THE-IP:8080/skyzone-player.apk` → server address → allow
"Display over other apps" → disable sleep/screensaver).

Name TVs in the dashboard **exactly as the booking sheet refers to rooms**
(e.g. `Room 1`, `Room 2`, `Main Court`) — the CSV matches on these names.
Decide the names before you start and keep a list.

## Phase 3 — acceptance test (do this before trusting it with a real party)

- [ ] All TVs show ONLINE in the dashboard
- [ ] Upload real media, build the default playlist, **Apply to ALL TVs** —
      every screen plays it
- [ ] **🎂 Test** on each room's TV — takeover appears on the right screen only
- [ ] Upload a CSV with a party 5 minutes out — takeover fires on time,
      reverts after its duration
- [ ] Pull the power on one TV box, plug back in — it relaunches into the
      player and re-pairs by itself
- [ ] **■ End day** blanks everything; **▶ Start day** restores everything
- [ ] Quit and restart the server — TVs reconnect within ~15 seconds

## Ongoing

- **Daily:** the 5-minute routine in [RUNBOOK.md](RUNBOOK.md).
- **Backups:** copy the `server/data` folder to a USB stick or cloud drive
  weekly — it contains every upload, playlist, theme, and TV name.
- **Remote access from home (optional):** install [Tailscale](https://tailscale.com)
  (free) on the laptop and your phone; the dashboard works from anywhere with
  nothing exposed to the internet.

## Later: replace the laptop with a mini PC (~$160, optional)

When you're tired of dedicating the laptop: buy a small Linux mini PC, copy
the whole `SkyzoneTV` folder (including `server/data`), give it the SAME IP
the laptop had, and run:

```bash
sudo bash deploy/install-linux.sh
```

That registers the server as a system service — starts on boot, restarts on
crashes, no terminal window to babysit. The TVs won't need any change.
