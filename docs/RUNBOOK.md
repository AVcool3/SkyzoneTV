# Daily Runbook — Skyzone TV

The whole daily routine happens in the dashboard on your phone or laptop:
`http://YOUR-SERVER-IP:8080/dashboard/`

## Morning (open the park)

1. Open the dashboard → press **▶ Start day**. All 12 screens wake to their
   assigned loops. (The server and TVs stay powered 24/7; "day end" just blanks
   the screens, so nothing needs to boot in the morning.)
2. Glance at the TV grid: every card should show **ONLINE**. An OFFLINE card
   means that stick lost power or Wi-Fi — power-cycle that TV's stick; it
   rejoins by itself.
3. Upload any new media for the day (**Media** tab → Upload MP4, or drag &
   drop), and adjust playlists if needed (**Media…** on a TV card, or
   **Set playlist for ALL TVs…**).
4. Upload today's parties (**Events** tab → **Upload events CSV**). Check the
   import summary — fix any flagged rows (usually a TV name typo) and
   re-upload. Re-uploading replaces the pending list, so it's safe to do twice.

## During the day

Nothing — it runs itself:

- At each party's start time, that room's TV shows **Happy Birthday {Name}**
  for 5 minutes, then returns to its loop. Only that TV is affected.
- Party running late? Open **Events** and hit **Start now** when they're ready,
  or **🎂 Test** on the TV card for an ad-hoc birthday screen.
- Need a screen dark (private event, maintenance)? TV card → **Screen off**.
  Everything else keeps playing.
- Wrong video somewhere? Change that one TV's **Media…** — takes effect in
  seconds, and no other TV so much as flickers.

## Evening (close the park)

1. Dashboard → **■ End day**. All screens go black; any active takeover is
   cleared; tomorrow's leftover events stay scheduled.
2. Optionally power off the physical TVs with the venue's normal switches —
   the sticks and server are designed to stay on and reconnect in the morning.

## If something looks wrong

| Symptom | Fix |
|---|---|
| TV card OFFLINE | Power-cycle that TV's Fire stick. It re-pairs automatically. |
| TV shows the orange idle screen | It has no playlist — open **Media…** on its card and assign videos. |
| Birthday didn't fire | Check **Events**: was the row imported? Does the `tv` column match the TV's name in the dashboard? Server clock right? |
| Dashboard unreachable | Is the mini PC on? Server auto-starts on boot; give it a minute, or restart the mini PC. |
| A TV is stuck on a birthday screen | TV card → **Stop takeover**. (Also auto-clears at the event's end time.) |
| Everything unreachable after a router change | The server needs its old IP — restore its static IP/DHCP reservation, or update the Start URL in each TV's Fully Kiosk settings. |
