"""Shared connection helper for the myCobot 280 Pi.

- On the robot's own Pi: talks to the arm directly over /dev/ttyAMA0.
- On any other computer: connects over Wi-Fi/Ethernet to pi/server.py.
  Set the Pi's address with the MYCOBOT_IP environment variable or --ip.
"""
import argparse
import os

from pymycobot import MyCobot280, MyCobot280Socket

PI_SERIAL_PORT = "/dev/ttyAMA0"
PI_BAUD = 1000000
DEFAULT_NET_PORT = 9000


def connect(ip=None, port=DEFAULT_NET_PORT):
    ip = ip or os.environ.get("MYCOBOT_IP")
    if ip:
        print(f"Connecting to myCobot at {ip}:{port} ...")
        return MyCobot280Socket(ip, port)
    if os.path.exists(PI_SERIAL_PORT):
        print(f"Connecting to myCobot on {PI_SERIAL_PORT} ...")
        return MyCobot280(PI_SERIAL_PORT, str(PI_BAUD))
    raise SystemExit("No robot address: set MYCOBOT_IP=<pi-ip> or pass --ip <pi-ip>.")


def connect_from_args(description=""):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--ip", help="Pi IP address (default: $MYCOBOT_IP)")
    parser.add_argument("--port", type=int, default=DEFAULT_NET_PORT)
    args = parser.parse_args()
    return connect(args.ip, args.port)
