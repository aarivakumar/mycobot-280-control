#!/usr/bin/env python3
"""Web control panel for the myCobot 280 Pi.

Run on this PC (talks to pi/server.py over the network):
    python webapp/app.py                       # then open http://localhost:8080
    MYCOBOT_IP=192.168.1.42 python webapp/app.py   # pre-fills / auto-connects

Run on the robot's Pi (reach it from any device on the LAN):
    python3 webapp/app.py --host 0.0.0.0

Try it without a robot:
    python webapp/app.py --mock

The server holds the only connection to the arm. A background thread polls the
arm's state, and every browser tab reads that cached state, so several open tabs
don't multiply traffic on the serial line.
"""
import argparse
import json
import math
import os
import re
import socket
import subprocess
import sys
import threading
import time

from concurrent.futures import ThreadPoolExecutor

from flask import Flask, jsonify, request, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

from robot import DEFAULT_NET_PORT, PI_BAUD, PI_SERIAL_PORT  # noqa: E402

POSES_FILE = os.path.join(HERE, "poses.json")
PROGRAMS_DIR = os.path.join(HERE, "programs")
POLL_INTERVAL = 0.25  # seconds between state reads

# Joystick jogging. The browser sends a velocity (-1..1 per axis) several times a
# second; if it goes quiet for JOG_TIMEOUT (tab closed, Wi-Fi drop) the arm stops.
JOG_HZ = 10
JOG_TIMEOUT = 0.5
JOG_MAX_LINEAR = 80.0  # mm/s at full stick and speed 100
JOG_MAX_ROT = 60.0     # deg/s
JOG_MAX_JOINT = 60.0   # deg/s
JOG_MAX_LEAD = 40.0    # resync the target if it runs this far ahead of the arm
SHOULDER_Z = 131.0     # mm, height of joint 2 above the base
MAX_REACH = 275.0      # mm from the shoulder

# Approximate joint limits (degrees), from the README.
JOINT_LIMITS = [(-168, 168), (-135, 135), (-150, 150), (-145, 145), (-165, 165), (-180, 180)]
# Approximate Cartesian workspace: x, y, z in mm; rx, ry, rz in degrees.
COORD_LIMITS = [(-281, 281), (-281, 281), (-70, 412), (-180, 180), (-180, 180), (-180, 180)]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def valid_list(v, n=6):
    """pymycobot returns -1, None or [] when the arm doesn't answer."""
    return isinstance(v, list) and len(v) == n and all(isinstance(x, (int, float)) for x in v)


class RobotError(Exception):
    pass


class Robot:
    """Owns the pymycobot connection; every call goes through one lock."""

    def __init__(self):
        self.mc = None
        self.lock = threading.RLock()
        self.target = None  # description of what we're connected to
        self.state = {"angles": None, "coords": None, "power": None, "gripper": None,
                      "version": None, "updated": None}
        self.last_error = None
        self.stop_event = threading.Event()
        threading.Thread(target=self._poll_loop, daemon=True).start()

    # --- connection ---
    def connect(self, mode, ip=None, port=DEFAULT_NET_PORT):
        self.disconnect()
        with self.lock:
            try:
                if mode == "mock":
                    from mock_robot import MockMyCobot
                    mc, target = MockMyCobot(), "mock robot"
                elif mode == "serial":
                    from pymycobot import MyCobot280
                    mc, target = MyCobot280(PI_SERIAL_PORT, str(PI_BAUD)), PI_SERIAL_PORT
                else:
                    if not ip:
                        raise RobotError("Enter the Pi's IP address.")
                    # pymycobot connects with no timeout; probe first so a wrong IP
                    # fails in seconds instead of minutes.
                    try:
                        socket.create_connection((ip, int(port)), timeout=3).close()
                    except socket.timeout:
                        raise RobotError("No answer from %s:%s. Check the IP and that the Pi is on this network." % (ip, port))
                    except OSError as e:
                        raise RobotError("Can't reach %s:%s (%s). Is pi/server.py running?" % (ip, port, e.strerror or e))
                    from pymycobot import MyCobot280Socket
                    mc, target = MyCobot280Socket(ip, int(port)), "%s:%s" % (ip, port)
            except RobotError:
                raise
            except Exception as e:
                raise RobotError("Could not connect: %s" % e)
            self.mc, self.target = mc, target
            self.last_error = None
            try:
                self.state["version"] = mc.get_system_version()
                self.state["power"] = mc.is_power_on()
            except Exception as e:
                self.last_error = "Connected, but the arm did not answer: %s" % e
        self.read_state()

    def disconnect(self):
        with self.lock:
            if self.mc is not None:
                try:
                    self.mc.close()
                except Exception:
                    pass
            self.mc, self.target = None, None
            for k in self.state:
                self.state[k] = None

    # --- calls ---
    def call(self, method, *args):
        with self.lock:
            if self.mc is None:
                raise RobotError("Not connected.")
            try:
                return getattr(self.mc, method)(*args)
            except Exception as e:
                self.last_error = "%s failed: %s" % (method, e)
                raise RobotError(self.last_error)

    def read_state(self):
        with self.lock:
            if self.mc is None:
                return
            try:
                angles = self.mc.get_angles()
                coords = self.mc.get_coords()
            except Exception as e:
                self.last_error = "Lost contact with the arm: %s" % e
                return
            self.state["angles"] = angles if valid_list(angles) else None
            self.state["coords"] = coords if valid_list(coords) else None
            self.state["updated"] = time.time()

    def current_angles(self):
        self.read_state()
        if self.state["angles"] is None:
            raise RobotError("Can't read joint angles. Is the arm powered (12V)?")
        return list(self.state["angles"])

    def current_coords(self):
        self.read_state()
        if self.state["coords"] is None:
            raise RobotError("Can't read coordinates. Is the arm powered (12V)?")
        return list(self.state["coords"])

    def _poll_loop(self):
        while not self.stop_event.wait(POLL_INTERVAL):
            if self.mc is not None:
                self.read_state()

    def snapshot(self):
        s = dict(self.state)
        s["connected"] = self.mc is not None
        s["target"] = self.target
        s["error"] = self.last_error
        return s


class Jogger:
    """Turns joystick velocities into a stream of small moves."""

    def __init__(self, robot):
        self.robot = robot
        self.lock = threading.Lock()
        self.mode, self.vel, self.speed = None, [0.0] * 6, 50
        self.deadline = 0.0
        self.target = None  # where we've told the arm to go; None while idle
        threading.Thread(target=self._loop, daemon=True).start()

    def set(self, mode, vel, speed):
        with self.lock:
            if mode != self.mode:
                self.target = None
            self.mode, self.vel, self.speed = mode, vel, speed
            self.deadline = time.time() + JOG_TIMEOUT

    def halt(self):
        with self.lock:
            self.vel, self.target, self.mode = [0.0] * 6, None, None

    def _loop(self):
        dt = 1.0 / JOG_HZ
        ticks = 0
        while True:
            time.sleep(dt)
            with self.lock:
                active = any(self.vel) and time.time() < self.deadline and self.robot.mc is not None
                was_moving = self.target is not None
                if not active:
                    self.target = None
                    self.vel = [0.0] * 6
                mode, vel, speed = self.mode, list(self.vel), self.speed
            if not active:
                if was_moving:
                    try:
                        self.robot.call("stop")
                    except RobotError:
                        pass
                continue
            ticks += 1
            try:
                self._step(mode, vel, speed, dt, resync=ticks % JOG_HZ == 0)
            except RobotError:
                self.halt()

    def _step(self, mode, vel, speed, dt, resync):
        scale = speed / 100.0
        cmd_speed = int(clamp(speed + 20, 30, 100))
        target = self.target
        if mode == "coord":
            if target is None or resync:
                actual = self.robot.current_coords()
                if target is None or math.sqrt(sum((a - t) ** 2 for a, t in zip(actual[:3], target[:3]))) > JOG_MAX_LEAD:
                    target = actual
            for i in range(6):
                rate = JOG_MAX_LINEAR if i < 3 else JOG_MAX_ROT
                target[i] += vel[i] * rate * scale * dt
                if i >= 3:
                    target[i] = (target[i] + 180) % 360 - 180
                lo, hi = COORD_LIMITS[i]
                target[i] = clamp(target[i], lo, hi)
            limit_reach(target)
            self.robot.call("send_coords", [round(c, 1) for c in target], cmd_speed, 0)
        else:
            if target is None or resync:
                actual = self.robot.current_angles()
                if target is None or max(abs(a - t) for a, t in zip(actual, target)) > JOG_MAX_LEAD:
                    target = actual
            for i in range(6):
                lo, hi = JOINT_LIMITS[i]
                target[i] = clamp(target[i] + vel[i] * JOG_MAX_JOINT * scale * dt, lo, hi)
            self.robot.call("send_angles", [round(a, 1) for a in target], cmd_speed)
        with self.lock:
            if self.mode == mode and any(self.vel):
                self.target = target


def limit_reach(c):
    """Pull x, y, z back inside a sphere the arm can actually reach."""
    dz = c[2] - SHOULDER_Z
    r = math.sqrt(c[0] ** 2 + c[1] ** 2 + dz ** 2)
    if r > MAX_REACH:
        f = MAX_REACH / r
        c[0], c[1], c[2] = c[0] * f, c[1] * f, SHOULDER_Z + dz * f


# Interfaces that never lead to the robot (containers, VPNs, loopback).
VIRTUAL_IFACES = ("lo", "docker", "br-", "veth", "virbr", "tailscale", "tun", "tap", "wg", "zt", "utun", "awdl", "llw")
ROBOT_HOSTNAMES = ("mycobot.local", "er.local", "raspberrypi.local", "ubuntu.local", "pi.local")


def _run(cmd):
    try:
        return subprocess.check_output(cmd, universal_newlines=True, stderr=subprocess.DEVNULL, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return ""


def is_wired(name):
    """True for an Ethernet port (incl. USB adapters), False for Wi-Fi, None if unknown."""
    if os.path.isdir("/sys/class/net/%s" % name):
        return not os.path.exists("/sys/class/net/%s/wireless" % name) and not name.startswith("wl")
    return None


def interfaces():
    """This machine's usable IPv4 interfaces: [{"name", "ip", "wired"}]."""
    found = []
    text = _run(["ip", "-4", "-o", "addr", "show"])
    for m in re.finditer(r"^\d+:\s+(\S+)\s+inet\s+([\d.]+)/(\d+)", text, re.M):
        found.append((m.group(1), m.group(2), int(m.group(3))))
    if not found:  # macOS / BSD
        name = None
        for line in _run(["ifconfig"]).splitlines():
            if line and not line[0].isspace():
                name = line.split(":")[0]
            m = re.search(r"inet ([\d.]+) netmask 0x([0-9a-f]+)", line)
            if m and name:
                found.append((name, m.group(1), bin(int(m.group(2), 16)).count("1")))
    if not found:  # anything else: at least the interface with the default route
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the LAN interface
            found.append(("?", s.getsockname()[0], 24))
            s.close()
        except OSError:
            pass
    return [{"name": n, "ip": ip, "prefix": plen, "wired": is_wired(n)} for n, ip, plen in found
            if not n.startswith(VIRTUAL_IFACES) and not ip.startswith("127.") and plen < 32]


def neighbours():
    """IPs this machine has recently talked to (ARP/neighbour table): {ip: interface}."""
    out = {}
    for line in _run(["ip", "-4", "neigh"]).splitlines():
        parts = line.split()
        if len(parts) >= 3 and "FAILED" not in line and "INCOMPLETE" not in line:
            out[parts[0]] = parts[2]
    if not out:
        for m in re.finditer(r"\(?([\d.]+)\)?\s.*?(?:on\s+(\S+))?$", _run(["arp", "-a"]), re.M):
            out[m.group(1)] = m.group(2) or "?"
    return out


def resolve_hostnames():
    """Try the usual Pi hostnames over mDNS. Returns {ip: hostname}."""
    def lookup(host):
        try:
            return host, socket.gethostbyname(host)
        except OSError:
            return host, None
    pool = ThreadPoolExecutor(max_workers=len(ROBOT_HOSTNAMES))
    futures = [pool.submit(lookup, h) for h in ROBOT_HOSTNAMES]
    pool.shutdown(wait=False)  # don't wait for slow lookups past the deadline
    deadline = time.time() + 2.0
    out = {}
    for f in futures:
        try:
            host, ip = f.result(timeout=max(0.0, deadline - time.time()))
        except Exception:
            continue
        if ip and not ip.startswith("127."):
            out[ip] = host
    return out


def iface_for(ip, ifaces):
    """The local interface whose /24 (or link-local range) contains ip."""
    for i in ifaces:
        if ip.rsplit(".", 1)[0] == i["ip"].rsplit(".", 1)[0]:
            return i
        if ip.startswith("169.254.") and i["ip"].startswith("169.254."):
            return i
    return None


def port_open(ip, port, timeout=0.5):
    try:
        socket.create_connection((ip, port), timeout=timeout).close()
        return True
    except OSError:
        return False


app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="")  # pages use relative paths, so the same files also work on GitHub Pages
robot = Robot()
jogger = Jogger(robot)


def body():
    return request.get_json(silent=True) or {}


def speed_arg(data):
    return int(clamp(int(data.get("speed", 30)), 1, 100))


def ok(**extra):
    out = {"ok": True, "state": robot.snapshot()}
    out.update(extra)
    return jsonify(out)


@app.errorhandler(RobotError)
def handle_robot_error(e):
    return jsonify({"ok": False, "error": str(e), "state": robot.snapshot()}), 400


@app.errorhandler(ValueError)
@app.errorhandler(TypeError)
@app.errorhandler(KeyError)
def handle_bad_request(e):
    return jsonify({"ok": False, "error": "Bad request: %s" % e, "state": robot.snapshot()}), 400


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/config")
def config():
    return jsonify({
        "default_ip": os.environ.get("MYCOBOT_IP", ""),
        "default_port": DEFAULT_NET_PORT,
        "serial_available": os.path.exists(PI_SERIAL_PORT),
        "joint_limits": JOINT_LIMITS,
        "coord_limits": COORD_LIMITS,
    })


@app.route("/api/state")
def state():
    return jsonify(robot.snapshot())


@app.route("/api/connect", methods=["POST"])
def connect():
    d = body()
    robot.connect(d.get("mode", "network"), d.get("ip"), d.get("port", DEFAULT_NET_PORT))
    return ok()


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    jogger.halt()
    robot.disconnect()
    return ok()


@app.route("/api/angles", methods=["POST"])
def send_angles():
    d = body()
    angles = [float(a) for a in d["angles"]]
    if len(angles) != 6:
        raise ValueError("need 6 angles")
    angles = [clamp(a, lo, hi) for a, (lo, hi) in zip(angles, JOINT_LIMITS)]
    robot.call("send_angles", angles, speed_arg(d))
    return ok()


@app.route("/api/angle", methods=["POST"])
def send_angle():
    """Set one joint. Pass "angle" for an absolute value or "delta" to jog."""
    d = body()
    joint = int(d["joint"])
    if not 1 <= joint <= 6:
        raise ValueError("joint must be 1-6")
    if "delta" in d:
        angle = robot.current_angles()[joint - 1] + float(d["delta"])
    else:
        angle = float(d["angle"])
    lo, hi = JOINT_LIMITS[joint - 1]
    robot.call("send_angle", joint, clamp(angle, lo, hi), speed_arg(d))
    return ok()


@app.route("/api/coords", methods=["POST"])
def send_coords():
    d = body()
    coords = [float(c) for c in d["coords"]]
    if len(coords) != 6:
        raise ValueError("need 6 coordinates")
    coords = [clamp(c, lo, hi) for c, (lo, hi) in zip(coords, COORD_LIMITS)]
    robot.call("send_coords", coords, speed_arg(d), int(d.get("mode", 0)))
    return ok()


@app.route("/api/jog_coord", methods=["POST"])
def jog_coord():
    """Move the end effector by "delta" along one axis (1-6 = x, y, z, rx, ry, rz)."""
    d = body()
    axis = int(d["axis"])
    if not 1 <= axis <= 6:
        raise ValueError("axis must be 1-6")
    coords = robot.current_coords()
    coords[axis - 1] += float(d["delta"])
    if axis >= 4:  # wrap rotations into -180..180
        coords[axis - 1] = (coords[axis - 1] + 180) % 360 - 180
    lo, hi = COORD_LIMITS[axis - 1]
    coords[axis - 1] = clamp(coords[axis - 1], lo, hi)
    robot.call("send_coords", coords, speed_arg(d), 0)
    return ok()


@app.route("/api/network")
def network():
    """Local interfaces, so the page can say whether a cable is plugged in."""
    return jsonify({"ok": True, "interfaces": interfaces()})


@app.route("/api/scan", methods=["POST"])
def scan():
    """Look for the Pi bridge on every local network: Wi-Fi, Ethernet cable, USB adapters."""
    port = int(body().get("port", DEFAULT_NET_PORT))
    ifaces = interfaces()
    candidates = {}
    for i in ifaces:
        if i["ip"].startswith("169.254."):
            continue  # link-local is a /16; rely on neighbours and mDNS there
        net = i["ip"].rsplit(".", 1)[0]
        for n in range(1, 255):
            candidates.setdefault("%s.%d" % (net, n), None)
    for ip in neighbours():
        candidates[ip] = None
    names = resolve_hostnames()
    for ip in names:
        candidates[ip] = None
    hosts = [h for h in candidates if h not in [i["ip"] for i in ifaces]]
    with ThreadPoolExecutor(max_workers=128) as pool:
        hits = [h for h, up in zip(hosts, pool.map(lambda h: port_open(h, port), hosts)) if up]
    found = []
    for ip in hits:
        i = iface_for(ip, ifaces)
        found.append({"ip": ip, "iface": i["name"] if i else None,
                      "wired": i["wired"] if i else None, "hostname": names.get(ip)})
    found.sort(key=lambda f: (f["wired"] is not True, f["ip"]))  # cable first
    return jsonify({"ok": True, "found": found, "interfaces": ifaces, "port": port})


@app.route("/api/jog", methods=["POST"])
def jog():
    """Continuous jog. mode "coord" (x,y,z,rx,ry,rz) or "joint" (J1-J6); v = six values -1..1."""
    d = body()
    mode = "joint" if d.get("mode") == "joint" else "coord"
    vel = [clamp(float(v), -1.0, 1.0) for v in d["v"]]
    if len(vel) != 6:
        raise ValueError("need 6 velocities")
    if robot.mc is None:
        raise RobotError("Not connected.")
    jogger.set(mode, vel, speed_arg(d))
    return jsonify({"ok": True})


@app.route("/api/stop", methods=["POST"])
def stop():
    jogger.halt()
    robot.call("stop")
    return ok()


@app.route("/api/power", methods=["POST"])
def power():
    on = bool(body().get("on", True))
    robot.call("power_on" if on else "power_off")
    robot.state["power"] = 1 if on else 0
    return ok()


@app.route("/api/servos", methods=["POST"])
def servos():
    locked = bool(body().get("locked", True))
    robot.call("focus_all_servos" if locked else "release_all_servos")
    return ok()


@app.route("/api/color", methods=["POST"])
def color():
    d = body()
    r, g, b = (int(clamp(int(d[k]), 0, 255)) for k in ("r", "g", "b"))
    robot.call("set_color", r, g, b)
    return ok()


@app.route("/api/gripper", methods=["POST"])
def gripper():
    """value: 0 (closed) to 100 (open)."""
    d = body()
    value = int(clamp(int(d["value"]), 0, 100))
    robot.call("set_gripper_value", value, speed_arg(d))
    robot.state["gripper"] = value
    return ok()


# --- saved poses ---
def load_poses():
    try:
        with open(POSES_FILE) as f:
            return json.load(f)
    except (IOError, ValueError):
        return {"Home": [0, 0, 0, 0, 0, 0]}


def save_poses(poses):
    with open(POSES_FILE, "w") as f:
        json.dump(poses, f, indent=2)


@app.route("/api/poses", methods=["GET"])
def list_poses():
    return jsonify(load_poses())


@app.route("/api/poses", methods=["POST"])
def add_pose():
    d = body()
    name = str(d.get("name", "")).strip()[:40]
    if not name:
        raise ValueError("pose needs a name")
    poses = load_poses()
    poses[name] = [round(a, 2) for a in robot.current_angles()]
    save_poses(poses)
    return jsonify(poses)


@app.route("/api/poses/<path:name>", methods=["DELETE"])
def delete_pose(name):
    poses = load_poses()
    poses.pop(name, None)
    save_poses(poses)
    return jsonify(poses)


# --- block programs ---
def program_path(name):
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", str(name)).strip()[:60]
    if not safe:
        raise ValueError("program needs a name (letters, numbers, spaces, - and _)")
    return os.path.join(PROGRAMS_DIR, safe + ".json"), safe


@app.route("/api/programs", methods=["GET"])
def list_programs():
    if not os.path.isdir(PROGRAMS_DIR):
        return jsonify([])
    return jsonify(sorted(f[:-5] for f in os.listdir(PROGRAMS_DIR) if f.endswith(".json")))


@app.route("/api/programs/<path:name>", methods=["GET"])
def get_program(name):
    path, _ = program_path(name)
    if not os.path.exists(path):
        return jsonify({"ok": False, "error": "No program called %s" % name}), 404
    with open(path) as f:
        return jsonify(json.load(f))


@app.route("/api/programs/<path:name>", methods=["PUT"])
def save_program(name):
    path, safe = program_path(name)
    if not os.path.isdir(PROGRAMS_DIR):
        os.makedirs(PROGRAMS_DIR)
    with open(path, "w") as f:
        json.dump(body(), f)
    return jsonify({"ok": True, "name": safe})


@app.route("/api/programs/<path:name>", methods=["DELETE"])
def delete_program(name):
    path, _ = program_path(name)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"ok": True})


def main():
    parser = argparse.ArgumentParser(description="myCobot 280 Pi web control panel")
    parser.add_argument("--host", default="127.0.0.1",
                        help="interface to serve on (0.0.0.0 to allow other devices)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--ip", default=os.environ.get("MYCOBOT_IP"),
                        help="connect to the bridge on this Pi IP at startup")
    parser.add_argument("--serial", action="store_true",
                        help="connect to %s at startup (running on the Pi)" % PI_SERIAL_PORT)
    parser.add_argument("--mock", action="store_true", help="use a simulated robot")
    args = parser.parse_args()

    try:
        if args.mock:
            robot.connect("mock")
        elif args.serial:
            robot.connect("serial")
        elif args.ip:
            robot.connect("network", args.ip)
    except RobotError as e:
        print("Startup connection failed: %s (connect from the web page instead)" % e)

    print("myCobot web control: http://%s:%d" % (
        "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host, args.port))
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
