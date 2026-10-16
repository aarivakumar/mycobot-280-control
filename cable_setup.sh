#!/usr/bin/env bash
# Connect to the myCobot 280 Pi with an Ethernet cable (run on your Linux computer).
#
#   1. Plug a network cable from the robot's base (Ethernet port) into this computer.
#      No Ethernet port? A USB-to-Ethernet adapter works the same way.
#   2. bash cable_setup.sh            (one time; it reconnects automatically afterwards)
#
# This computer shares its network on that port (NetworkManager "shared" mode), so the
# robot gets an address like 10.42.0.x automatically. Then the script looks for the
# robot's bridge on port 9000.
#
#   bash cable_setup.sh enx00e04c...  use this wired interface instead of the first one found
#   bash cable_setup.sh --undo        remove the cable connection profile again
set -euo pipefail
CON=mycobot-cable
PORT=9000

command -v nmcli >/dev/null || { echo "This script needs NetworkManager (nmcli). See README: 'Connect with a cable'."; exit 1; }

if [[ "${1:-}" == "--undo" ]]; then
  nmcli connection delete "$CON" && echo "Removed the $CON connection."
  exit 0
fi

IFACE="${1:-$(nmcli -t -f DEVICE,TYPE device | awk -F: '$2 == "ethernet" { print $1; exit }')}"
if [[ -z "$IFACE" ]]; then
  echo "No wired network port found."
  echo "Plug in the cable (or a USB-to-Ethernet adapter), wait a few seconds, and run this again."
  exit 1
fi
echo "Using wired port: $IFACE"

if nmcli -t -f NAME connection show | grep -qx "$CON"; then
  nmcli connection modify "$CON" connection.interface-name "$IFACE" ipv4.method shared
else
  nmcli connection add type ethernet ifname "$IFACE" con-name "$CON" \
    ipv4.method shared ipv6.method disabled connection.autoconnect yes >/dev/null
fi
nmcli connection up "$CON" >/dev/null || {
  echo "Couldn't bring up the cable connection. Is the cable plugged in at both ends and the robot switched on?"
  exit 1
}
MY_IP="$(ip -4 -o addr show dev "$IFACE" | awk '{ split($4, a, "/"); print a[1]; exit }')"
NET="${MY_IP%.*}"
echo "This computer is $MY_IP on the cable. Waiting for the robot to get an address (up to a minute)..."

probe() { timeout 0.5 bash -c "echo > /dev/tcp/$1/$PORT" 2>/dev/null; }
for attempt in $(seq 1 20); do
  FOUND="$(for n in $(seq 2 254); do
      [[ "$NET.$n" == "$MY_IP" ]] || { probe "$NET.$n" && echo "$NET.$n"; } &
    done | head -1 || true)"
  if [[ -n "$FOUND" ]]; then
    echo
    echo "Found the robot at $FOUND"
    echo "  Control app:  ./start.sh   then choose 'With a cable' (or type $FOUND)"
    echo "  Scripts:      export MYCOBOT_IP=$FOUND"
    echo "  SSH:          ssh er@$FOUND"
    exit 0
  fi
  sleep 3
done

echo
echo "The cable link is up, but nothing answered on port $PORT yet."
echo "  - Give the robot a minute after power-on, then run this script again."
echo "  - The bridge must be installed on the Pi once (see README, step 2)."
echo "    Devices on the cable now: $(ip neigh show dev "$IFACE" | awk '!/FAILED|INCOMPLETE/ { printf "%s ", $1 }')"
echo "    If one of those is the robot, you can SSH to it to install the bridge."
exit 1
