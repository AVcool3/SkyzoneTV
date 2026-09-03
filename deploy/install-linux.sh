#!/usr/bin/env bash
# One-shot installer for the Skyzone TV server on a Linux mini PC
# (Ubuntu/Debian). Run from anywhere inside the checkout:
#
#   sudo bash deploy/install-linux.sh
#
# It installs dependencies, registers a systemd service so the server starts
# on boot and restarts if it ever crashes, and prints the dashboard address.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash deploy/install-linux.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$REPO_DIR/server"
RUN_USER="${SUDO_USER:-root}"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js…"
  apt-get update -qq
  apt-get install -y nodejs npm
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$($NODE_BIN -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ required (found $($NODE_BIN --version)). Install a newer Node and re-run." >&2
  exit 1
fi

echo "Installing server dependencies…"
cd "$SERVER_DIR"
sudo -u "$RUN_USER" npm install --omit=dev --no-audit --no-fund

echo "Registering systemd service…"
cat > /etc/systemd/system/skyzone-tv.service <<EOF
[Unit]
Description=Skyzone TV signage server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_BIN src/index.js
Restart=always
RestartSec=3
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now skyzone-tv.service
sleep 2

echo
echo "──────────────────────────────────────────────────────"
systemctl --no-pager --lines=0 status skyzone-tv.service | head -3
echo
echo "Server output (addresses + dashboard password):"
journalctl -u skyzone-tv.service --no-pager -n 12 -o cat
echo "──────────────────────────────────────────────────────"
echo
echo "Useful commands:"
echo "  journalctl -u skyzone-tv -f      # live logs"
echo "  systemctl restart skyzone-tv     # restart the server"
echo "  systemctl stop skyzone-tv        # stop it"
