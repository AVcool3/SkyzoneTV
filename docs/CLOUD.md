# Hosting in the cloud

Cloud hosting gives you: a permanent HTTPS address (no more LAN IPs), the
dashboard reachable from anywhere, no laptop tied up at the park, automatic
updates on every code push, and one instance per venue when you onboard other
locations. The trade-off: TVs stream media over the venue's internet
connection instead of the LAN (fine in practice — boxes cache media after the
first loop).

## Recommended: Render (~$12/month per venue)

1. Merge the code to your repo's main branch (or note the branch name).
2. Create an account at [render.com](https://render.com) and connect your
   GitHub.
3. **New → Blueprint** → pick the `SkyzoneTV` repo. Render reads
   `render.yaml` and provisions everything: the web service, a 20GB
   persistent disk for media, and cloud mode (`REQUIRE_TV_APPROVAL=1`).
4. When the first deploy finishes you get a URL like
   `https://skyzone-tv.onrender.com`. Open the service's **Logs** tab — the
   dashboard password is printed there on startup (or set your own by adding
   an `ADMIN_PASSWORD` environment variable and redeploying).
5. Dashboard: `https://skyzone-tv.onrender.com/dashboard/` — works from any
   phone or laptop, anywhere.

Cost: Starter instance $7/mo + 20GB disk ~$5/mo ≈ **$12/month**, includes
generous bandwidth. Scale the disk up later if the media library grows.

### TVs against the cloud

Per-TV setup is the same as [SETUP.md](SETUP.md), with two differences:

- The app/Downloader URLs use the cloud address:
  APK at `https://skyzone-tv.onrender.com/skyzone-player.apk`, server address
  `https://skyzone-tv.onrender.com`.
- **Approval:** in cloud mode a new screen doesn't join automatically —
  it shows a 6-digit pairing code and waits. Open the dashboard's TVs tab,
  find the card showing that code, press **Approve**, then name it. (This is
  what keeps random internet visitors from pairing screens to your server.)

### Updating

Push (or merge) to the deployed branch — Render redeploys automatically
within a couple of minutes. Uploaded media and settings live on the
persistent disk and survive every deploy.

## Alternative: your own VPS (~$6–12/month, more control)

Any Ubuntu VPS (DigitalOcean, Lightsail, Hetzner):

1. Clone the repo, run `sudo bash deploy/install-linux.sh` (installs the
   systemd service).
2. Add `Environment=REQUIRE_TV_APPROVAL=1` to
   `/etc/systemd/system/skyzone-tv.service` and restart.
3. Put [Caddy](https://caddyserver.com) in front for automatic HTTPS:
   `your.domain.com { reverse_proxy localhost:8080 }`
4. Point a domain at the VPS.

## Notes for cloud deployments

- The dashboard password and TV approval are the security boundary — use a
  strong `ADMIN_PASSWORD`, and reject pairing codes you don't recognize.
- Media file URLs are unguessable (random 128-bit ids) but not logged-in-only;
  don't upload anything confidential.
- Login is rate-limited (10 attempts / 15 min per IP).
- One venue = one instance. Onboarding another location means running this
  same blueprint again under a new name — nothing is shared between venues.
