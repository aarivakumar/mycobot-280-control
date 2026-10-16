#!/usr/bin/env python3
"""TCP -> serial bridge for the myCobot 280 Pi.

Run this ON the robot's Raspberry Pi. It listens on TCP port 9000 and forwards
raw pymycobot protocol frames to the arm's ATOM controller over /dev/ttyAMA0,
then sends the controller's reply back. From another computer, connect with:

    from pymycobot import MyCobot280Socket
    mc = MyCobot280Socket("<pi-ip>", 9000)

Kept compatible with the older Python 3 on the stock myCobot Pi image.
"""
import argparse
import socket
import time

import serial

FRAME_HEADER = b"\xfe\xfe"
REPLY_TIMEOUT = 0.15  # seconds to wait for the controller's reply


def read_reply(ser):
    """Read one reply frame (FE FE LEN CMD ... FA) or whatever arrives before the timeout."""
    buf = b""
    deadline = time.time() + REPLY_TIMEOUT
    while time.time() < deadline:
        waiting = ser.in_waiting
        if waiting:
            buf += ser.read(waiting)
            start = buf.find(FRAME_HEADER)
            if start >= 0 and len(buf) >= start + 3:
                frame_len = buf[start + 2] + 3
                if len(buf) >= start + frame_len:
                    return buf[start:start + frame_len]
        else:
            time.sleep(0.002)
    return buf


def serve_client(conn, ser):
    with conn:
        while True:
            data = conn.recv(1024)
            if not data:
                return
            ser.reset_input_buffer()
            ser.write(data)
            ser.flush()
            reply = read_reply(ser)
            if reply:
                conn.sendall(reply)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--serial", default="/dev/ttyAMA0")
    parser.add_argument("--baud", type=int, default=1000000)
    args = parser.parse_args()

    ser = serial.Serial(args.serial, args.baud, timeout=0.1)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(1)
    print("myCobot bridge: %s @ %d  <->  tcp://%s:%d" % (args.serial, args.baud, args.host, args.port), flush=True)

    while True:
        conn, addr = srv.accept()
        print("client connected: %s:%d" % addr, flush=True)
        try:
            serve_client(conn, ser)
        except (ConnectionError, OSError) as e:
            print("client error: %s" % e, flush=True)
        print("client disconnected", flush=True)


if __name__ == "__main__":
    main()
