"use strict";
// Online demo: when the page is served without the Python app (GitHub Pages, a local
// file, or ?demo in the URL), answer the /api/* calls in the browser with a simulated
// arm, so the joystick and blocks can be tried without a robot. Mirrors webapp/app.py
// and webapp/mock_robot.py. Does nothing when the page comes from start.sh.

(function () {
  const DEMO = location.hostname.endsWith("github.io") || location.protocol === "file:" ||
    new URLSearchParams(location.search).has("demo");
  if (!DEMO) return;
  window.DEMO_MODE = true;

  const JOINT_LIMITS = [[-168, 168], [-135, 135], [-150, 150], [-145, 145], [-165, 165], [-180, 180]];
  const COORD_LIMITS = [[-281, 281], [-281, 281], [-70, 412], [-180, 180], [-180, 180], [-180, 180]];
  const HOME_COORDS = [156.7, -63.6, 304.4, -175.0, 0.0, -90.0];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => Date.now() / 1000;

  // ---------- simulated arm (same model as mock_robot.py) ----------
  const arm = {
    connected: false, power: 1, gripper: 0,
    start: [0, 0, 0, 0, 0, 0], target: [0, 0, 0, 0, 0, 0], t0: 0, duration: 0,
    coords: HOME_COORDS.slice(),
    angles() {
      if (this.duration <= 0) return this.target.slice();
      const f = Math.min(1, (now() - this.t0) / this.duration);
      return this.start.map((s, i) => s + (this.target[i] - s) * f);
    },
    moveTo(angles, speed) {
      this.start = this.angles();
      this.target = angles.map(Number);
      const dist = Math.max(...this.start.map((s, i) => Math.abs(this.target[i] - s)));
      this.duration = dist / (160 * Math.max(speed, 1) / 100);
      this.t0 = now();
    },
    stop() { this.target = this.angles(); this.duration = 0; },
  };

  // ---------- joystick jogging, like Jogger in app.py ----------
  const jog = { mode: null, v: [0, 0, 0, 0, 0, 0], speed: 50, deadline: 0 };
  setInterval(() => {
    if (!arm.connected || !jog.v.some((x) => x) || now() > jog.deadline) { jog.v = [0, 0, 0, 0, 0, 0]; return; }
    const dt = 0.1, scale = jog.speed / 100;
    if (jog.mode === "coord") {
      arm.coords = arm.coords.map((c, i) => {
        let n = c + jog.v[i] * (i < 3 ? 80 : 60) * scale * dt;
        if (i >= 3) n = ((n + 180) % 360 + 360) % 360 - 180;
        return Math.round(clamp(n, ...COORD_LIMITS[i]) * 10) / 10;
      });
    } else {
      const a = arm.angles().map((x, i) => clamp(x + jog.v[i] * 60 * scale * dt, ...JOINT_LIMITS[i]));
      arm.target = a; arm.duration = 0;
    }
  }, 100);

  // ---------- storage for poses and programs ----------
  function load(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  function snapshot() {
    if (!arm.connected) return { connected: false, angles: null, coords: null, power: null, gripper: null, version: null, updated: null, target: null, error: null };
    return {
      connected: true, target: "simulated arm (online demo)", error: null, version: "demo",
      angles: arm.power ? arm.angles().map((a) => Math.round(a * 100) / 100) : null,
      coords: arm.coords.slice(), power: arm.power, gripper: arm.gripper, updated: now(),
    };
  }

  class ApiError extends Error {}
  const need = () => { if (!arm.connected) throw new ApiError("Not connected."); };

  function route(method, path, d) {
    const parts = path.split("/").map(decodeURIComponent);  // e.g. ["poses", "Home"]
    const sp = clamp(parseInt(d.speed || 30, 10), 1, 100);
    switch (parts[0]) {
      case "config":
        return { default_ip: "", default_port: 9000, serial_available: false, joint_limits: JOINT_LIMITS, coord_limits: COORD_LIMITS };
      case "state": return snapshot();
      case "network": return { ok: true, interfaces: [] };
      case "scan": throw new ApiError("The online demo can't search your network. Download the app and run ./start.sh to connect a real robot.");
      case "connect":
        if (d.mode !== "mock") throw new ApiError("The online demo can't reach a real robot. Download the app and run ./start.sh on a computer connected to the robot (see the GitHub page). Or pick Demo.");
        arm.connected = true; return { ok: true, state: snapshot() };
      case "disconnect": arm.connected = false; return { ok: true, state: snapshot() };
      case "jog":
        need();
        jog.mode = d.mode === "joint" ? "joint" : "coord";
        jog.v = d.v.map((x) => clamp(Number(x), -1, 1));
        jog.speed = sp; jog.deadline = now() + 0.5;
        return { ok: true };
      case "stop": need(); jog.v = [0, 0, 0, 0, 0, 0]; arm.stop(); break;
      case "angles": need(); arm.moveTo(d.angles.map((a, i) => clamp(Number(a), ...JOINT_LIMITS[i])), sp); break;
      case "angle": {
        need();
        const j = parseInt(d.joint, 10);
        const a = arm.angles();
        a[j - 1] = clamp("delta" in d ? a[j - 1] + Number(d.delta) : Number(d.angle), ...JOINT_LIMITS[j - 1]);
        arm.moveTo(a, sp); break;
      }
      case "coords": need(); arm.coords = d.coords.map((c, i) => clamp(Number(c), ...COORD_LIMITS[i])); break;
      case "jog_coord": {
        need();
        const i = parseInt(d.axis, 10) - 1;
        arm.coords[i] = clamp(arm.coords[i] + Number(d.delta), ...COORD_LIMITS[i]); break;
      }
      case "power": need(); arm.power = d.on === false ? 0 : 1; break;
      case "servos": case "color": need(); break;
      case "gripper": need(); arm.gripper = clamp(parseInt(d.value, 10), 0, 100); break;
      case "poses": {
        const poses = load("demo-poses", { Home: [0, 0, 0, 0, 0, 0] });
        if (method === "POST") {
          need();
          const name = String(d.name || "").trim().slice(0, 40);
          if (!name) throw new ApiError("pose needs a name");
          poses[name] = arm.angles().map((a) => Math.round(a * 100) / 100);
        } else if (method === "DELETE") {
          delete poses[parts[1]];
        }
        save("demo-poses", poses);
        return poses;
      }
      case "programs": {
        const progs = load("demo-programs", {});
        if (!parts[1]) return Object.keys(progs).sort();
        const name = parts[1].replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60);
        if (!name) throw new ApiError("program needs a name (letters, numbers, spaces, - and _)");
        if (method === "PUT") { progs[name] = d; save("demo-programs", progs); return { ok: true, name }; }
        if (method === "DELETE") { delete progs[name]; save("demo-programs", progs); return { ok: true }; }
        if (!progs[name]) throw new ApiError("No program called " + name);
        return progs[name];
      }
      default: throw new ApiError("Unknown request " + path);
    }
    return { ok: true, state: snapshot() };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = new URL(typeof url === "string" ? url : url.url, location.href);
    const m = u.pathname.match(/\/api\/(.*)$/);
    if (!m) return realFetch(url, opts);
    const method = ((opts && opts.method) || "GET").toUpperCase();
    let body = {};
    try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (e) { /* not JSON */ }
    let status = 200, out;
    try {
      out = route(method, m[1], body);
    } catch (e) {
      status = 400;
      out = { ok: false, error: e instanceof ApiError ? e.message : "Bad request: " + e.message, state: snapshot() };
    }
    return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
  };
})();
