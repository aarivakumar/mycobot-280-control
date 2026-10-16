#!/usr/bin/env bash
# Run ON the myCobot 280 Pi:  bash setup_pi.sh [--service]
#   - installs/updates pymycobot + pyserial
#   - gives the current user access to the serial port
#   - with --service, installs server.py as a systemd service that starts on boot
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

python3 -m pip install --user --upgrade pymycobot pyserial
sudo usermod -aG dialout "$USER"

if [[ "${1:-}" == "--service" ]]; then
  sed -e "s|__USER__|$USER|" -e "s|__DIR__|$DIR|" "$DIR/mycobot-server.service" \
    | sudo tee /etc/systemd/system/mycobot-server.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now mycobot-server
  systemctl --no-pager status mycobot-server | head -5
fi

echo
echo "Pi IP address(es): $(hostname -I)"
echo "Done. If this was the first run, log out/in (or reboot) for serial permissions."
