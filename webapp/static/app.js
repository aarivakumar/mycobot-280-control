"use strict";
// Connect screen, live status, joystick / gamepad / keyboard jogging, saved poses.
// blocks.js uses the App object at the bottom.

const $ = (id) => document.getElementById(id);
const POLL_MS = 400;
const JOG_MS = 100;       // how often we send the joystick velocity
const DEADZONE = 0.12;

let config = null;
let state = { connected: false };
let connectMode = "network";
let jogMode = "coord";
let programRunning = false;

// ---------- helpers ----------
let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "info" ? " info" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "info" ? 2000 : 5000);
}

async function api(path, body, method, quiet) {
  const opts = { method: method || (body === undefined ? "GET" : "POST"), headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res, data;
  try {
    res = await fetch(path, opts);
    data = await res.json();
  } catch (e) {
    if (!quiet) toast("Can't reach the control app. Is webapp/app.py still running?");
    throw new Error("Control app unreachable");
  }
  if (data && data.state) render(data.state);
  if (!res.ok || data.ok === false) {
    const msg = (data && data.error) || "Request failed";
    if (!quiet) toast(msg);
    throw new Error(msg);
  }
  return data;
}

const speed = () => Number($("speed").value);
const fmt = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
function recall(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

// ---------- screens ----------
function showScreen(connected) {
  $("connect-screen").hidden = connected;
  $("control-screen").hidden = !connected;
  if (connected) window.dispatchEvent(new Event("resize"));  // let Blockly size itself
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $("tab-joystick").hidden = name !== "joystick";
  $("tab-blocks").hidden = name !== "blocks";
  store("tab", name);
  window.dispatchEvent(new Event("resize"));
}

// ---------- state ----------
function render(s) {
  const wasConnected = state.connected;
  state = s;
  if (!s.connected) {
    if (wasConnected) {
      showScreen(false);
      toast("Disconnected from the robot.", "info");
    }
    return;
  }
  const answering = Array.isArray(s.angles);
  $("dot").className = "dot " + (answering ? "ok" : "bad");
  $("target").textContent = s.target + (answering ? "" : " · arm not answering");
  for (let i = 0; i < 6; i++) {
    $("a" + i).textContent = fmt(s.angles && s.angles[i]);
    $("c" + i).textContent = fmt(s.coords && s.coords[i]);
  }
  const w = $("warn");
  if (!answering) {
    w.hidden = false;
    w.textContent = "Connected to the Pi, but the arm isn't replying. Check the 12 V power switch, then press Power on.";
  } else if (s.power === 0) {
    w.hidden = false;
    w.textContent = "Servos are powered off. Press Power on to move the arm.";
  } else {
    w.hidden = true;
  }
}

async function poll() {
  try {
    const s = await (await fetch("/api/state")).json();
    render(s);
  } catch (e) { /* server restarting; try again next tick */ }
  setTimeout(poll, POLL_MS);
}

// ---------- connect ----------
function setConnectMode(mode) {
  connectMode = mode;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll(".mode-panel").forEach((p) => (p.hidden = p.dataset.panel !== mode));
}

function step(text, cls) {
  const li = document.createElement("li");
  li.textContent = text;
  li.className = cls;
  $("steps").appendChild(li);
  return li;
}

async function doConnect() {
  const steps = $("steps");
  steps.innerHTML = "";
  steps.hidden = false;
  const btn = $("connect");
  btn.disabled = true;
  const ip = $("ip").value.trim();
  const port = Number($("port").value) || 9000;
  const label = connectMode === "network" ? `Reaching the robot at ${ip}:${port}` :
    connectMode === "serial" ? "Opening /dev/ttyAMA0" : "Starting the simulated arm";
  const s1 = step(label, "busy");
  try {
    if (connectMode === "network" && !ip) throw new Error("Type the robot's IP address, or use Find my robot.");
    const data = await api("/api/connect", { mode: connectMode, ip, port }, "POST", true);
    s1.className = "ok";
    if (connectMode === "network") { store("ip", ip); store("port", String(port)); }
    const st = data.state;
    if (st.version !== null && st.version !== undefined && st.version !== -1) {
      step("Arm controller replied (firmware " + st.version + ")", "ok");
    } else {
      step("The Pi answered but the arm didn't. Check the 12 V power. You can still continue.", "warn");
    }
    if (st.power === 0) step("Servos are off. Press Power on in the control screen.", "warn");
    await sleep(500);
    showScreen(true);
    loadPoses();
  } catch (e) {
    s1.className = "bad";
    step(e.message, "bad");
  } finally {
    btn.disabled = false;
  }
}

async function doScan() {
  const btn = $("scan");
  const list = $("scan-results");
  btn.disabled = true;
  btn.textContent = "Searching… (a few seconds)";
  list.innerHTML = "";
  try {
    const data = await api("/api/scan", { port: Number($("port").value) || 9000 });
    if (!data.found.length) {
      list.innerHTML = `<li class="none">No robot bridge found on ${data.subnets.map((n) => n + ".x").join(", ") || "this network"}.
        Make sure the Pi is on and the bridge service is running, or type the IP.</li>`;
    }
    data.found.forEach((ip) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = "🤖 " + ip + "  (tap to use)";
      b.onclick = () => { $("ip").value = ip; doConnect(); };
      li.appendChild(b);
      list.appendChild(li);
    });
  } catch (e) { /* toast already shown */ }
  btn.disabled = false;
  btn.textContent = "Find my robot on this network";
}

// ---------- stop ----------
async function stopAll() {
  App.onStop.forEach((fn) => fn());
  sticks.forEach((s) => s.reset());
  try { await api("/api/stop", {}); toast("Stopped", "info"); } catch (e) { /* shown */ }
}

// ---------- joystick ----------
class Stick {
  constructor(el) {
    this.el = el;
    this.knob = el.querySelector(".knob");
    this.x = 0; this.y = 0;
    this.pointer = null;
    el.addEventListener("pointerdown", (e) => {
      this.pointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add("active");
      this.move(e);
    });
    el.addEventListener("pointermove", (e) => { if (e.pointerId === this.pointer) this.move(e); });
    const end = (e) => { if (e.pointerId === this.pointer) this.reset(); };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  move(e) {
    const r = this.el.getBoundingClientRect();
    const radius = r.width / 2 - 20;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > radius) { dx *= radius / d; dy *= radius / d; }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this.x = dx / radius;
    this.y = -dy / radius;  // up is positive
  }
  reset() {
    this.pointer = null;
    this.x = 0; this.y = 0;
    this.knob.style.transform = "";
    this.el.classList.remove("active");
  }
}
const sticks = [];
const holds = new Map();     // axis index -> direction, from the J5/J6 hold buttons
const keys = new Set();

const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
const LABELS = {
  coord: ["Forward / back · Left / right", "Up / down · Twist"],
  joint: ["J1 base (←→) · J2 shoulder (↑↓)", "J4 wrist (←→) · J3 elbow (↑↓)"],
};

function setJogMode(mode) {
  jogMode = mode;
  document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b.dataset.jogmode === mode));
  $("label-left").textContent = LABELS[mode][0];
  $("label-right").textContent = LABELS[mode][1];
  $("joint-holds").hidden = mode !== "joint";
}

// Gamepad (standard mapping): edge-triggered buttons
let padPrev = [];
function readGamepad() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  const p = pads[0];
  const status = $("pad-status");
  status.textContent = p ? "🎮 " + p.id.split("(")[0].trim().slice(0, 28) : "🎮 No gamepad";
  status.classList.toggle("on", !!p);
  if (!p) return null;
  const pressed = p.buttons.map((b) => b.pressed);
  const edge = (i) => pressed[i] && !padPrev[i];
  if (edge(9) || edge(8)) stopAll();
  if (edge(0)) action("grip-close");
  if (edge(1)) action("grip-open");
  if (edge(2)) setJogMode(jogMode === "coord" ? "joint" : "coord");
  if (edge(3)) action("home");
  padPrev = pressed;
  const ax = (i) => dz(p.axes[i] || 0);
  return {
    lx: ax(0), ly: -ax(1), rx: ax(2), ry: -ax(3),
    j5: (pressed[5] ? 1 : 0) - (pressed[4] ? 1 : 0),
    j6: ((p.buttons[7] && p.buttons[7].value) || 0) - ((p.buttons[6] && p.buttons[6].value) || 0),
  };
}

function velocity() {
  const [L, R] = sticks;
  let lx = L.x, ly = L.y, rx = R.x, ry = R.y, j5 = holds.get(4) || 0, j6 = holds.get(5) || 0;
  const pad = readGamepad();
  if (pad) {
    lx = lx || pad.lx; ly = ly || pad.ly; rx = rx || pad.rx; ry = ry || pad.ry;
    j5 = j5 || pad.j5; j6 = j6 || pad.j6;
  }
  const k = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
  ly = ly || k("w", "s"); lx = lx || k("d", "a"); ry = ry || k("r", "f"); rx = rx || k("e", "q");
  if (jogMode === "coord") {
    // x forward, y to the robot's left, z up; right stick X twists the tool (rz)
    return [ly, -lx, ry, 0, 0, rx];
  }
  return [lx, ly, ry, rx, j5, j6];
}

let jogInFlight = false;
let wasJogging = false;
async function jogTick() {
  setTimeout(jogTick, JOG_MS);
  if (!state.connected) return;
  const v = velocity().map((x) => Math.round(x * 100) / 100);  // also handles gamepad buttons
  if (programRunning || jogInFlight) return;
  const moving = v.some((x) => x !== 0);
  if (!moving && !wasJogging) return;
  wasJogging = moving;
  jogInFlight = true;
  try { await api("/api/jog", { mode: jogMode, v, speed: speed() }, "POST", true); }
  catch (e) { if (moving) toast(e.message); }
  finally { jogInFlight = false; }
}

// ---------- buttons ----------
async function action(name) {
  const sp = speed();
  try {
    switch (name) {
      case "home": await api("/api/angles", { angles: [0, 0, 0, 0, 0, 0], speed: sp }); break;
      case "grip-open": await api("/api/gripper", { value: 100, speed: sp }); break;
      case "grip-close": await api("/api/gripper", { value: 0, speed: sp }); break;
      case "relax":
        if (!confirm("The arm will go limp and may drop. Hold it before continuing.")) return;
        await api("/api/servos", { locked: false }); break;
      case "lock": await api("/api/servos", { locked: true }); break;
      case "power-on": await api("/api/power", { on: true }); break;
    }
  } catch (e) { /* toast already shown */ }
}

function setLed(hex) {
  const n = parseInt(hex.slice(1), 16);
  api("/api/color", { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }).catch(() => {});
}

// ---------- poses ----------
async function loadPoses() {
  try {
    const poses = await api("/api/poses");
    App.poses = poses;
    const ul = $("poses");
    ul.innerHTML = "";
    Object.keys(poses).forEach((name) => {
      const li = document.createElement("li");
      const go = document.createElement("button");
      go.className = "go";
      go.textContent = "→ " + name;
      go.title = poses[name].join(", ");
      go.onclick = () => api("/api/angles", { angles: poses[name], speed: speed() }).catch(() => {});
      const del = document.createElement("button");
      del.className = "ghost";
      del.textContent = "✕";
      del.title = "Delete " + name;
      del.onclick = async () => {
        if (!confirm(`Delete pose "${name}"?`)) return;
        await api("/api/poses/" + encodeURIComponent(name), undefined, "DELETE");
        loadPoses();
      };
      li.append(go, del);
      ul.appendChild(li);
    });
  } catch (e) { /* shown */ }
}

async function savePose() {
  const name = $("pose-name").value.trim();
  if (!name) { toast("Give the pose a name first."); return; }
  try {
    await api("/api/poses", { name });
    $("pose-name").value = "";
    toast(`Saved "${name}"`, "info");
    loadPoses();
  } catch (e) { /* shown */ }
}

// ---------- wiring ----------
function initUi() {
  document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setConnectMode(b.dataset.mode)));
  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  document.querySelectorAll(".seg").forEach((b) => (b.onclick = () => setJogMode(b.dataset.jogmode)));
  document.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => action(b.dataset.act)));
  document.querySelectorAll(".hold").forEach((b) => {
    const axis = Number(b.dataset.axis), dir = Number(b.dataset.dir);
    b.addEventListener("pointerdown", (e) => { b.setPointerCapture(e.pointerId); holds.set(axis, dir); b.classList.add("active"); });
    const up = () => { holds.delete(axis); b.classList.remove("active"); };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
  });
  sticks.push(new Stick($("stick-left")), new Stick($("stick-right")));

  $("connect").onclick = doConnect;
  $("ip").addEventListener("keydown", (e) => { if (e.key === "Enter") doConnect(); });
  $("scan").onclick = doScan;
  $("disconnect").onclick = async () => { await api("/api/disconnect", {}).catch(() => {}); showScreen(false); };
  $("stop").onclick = stopAll;
  $("speed").oninput = () => { $("speed-val").textContent = $("speed").value; store("speed", $("speed").value); };
  $("led").onchange = (e) => setLed(e.target.value);
  $("pose-save").onclick = savePose;
  $("pose-name").addEventListener("keydown", (e) => { if (e.key === "Enter") savePose(); });

  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { stopAll(); return; }
    if (typing(e) || $("tab-joystick").hidden || $("control-screen").hidden) return;
    const k = e.key.toLowerCase();
    if ("wasdrfqe".includes(k) && k.length === 1) { keys.add(k); e.preventDefault(); }
  });
  document.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => { keys.clear(); holds.clear(); sticks.forEach((s) => s.reset()); });
}

async function init() {
  initUi();
  const savedSpeed = recall("speed");
  if (savedSpeed) { $("speed").value = savedSpeed; $("speed-val").textContent = savedSpeed; }
  try {
    config = await (await fetch("/api/config")).json();
  } catch (e) {
    toast("Can't reach the control app.");
    return;
  }
  // On the robot's own Pi, the bridge is local.
  $("ip").value = config.default_ip || recall("ip") || (config.serial_available ? "127.0.0.1" : "");
  $("port").value = recall("port") || config.default_port;
  if (!config.serial_available) $("mode-serial").hidden = true;
  const s = await (await fetch("/api/state")).json();
  render(s);
  showScreen(s.connected);
  showTab(recall("tab") || "joystick");
  if (s.connected) loadPoses();
  poll();
  jogTick();
}

// Shared with blocks.js
const App = {
  api, sleep, toast, speed, stopAll, loadPoses,
  poses: {},
  onStop: [],
  get state() { return state; },
  get config() { return config; },
  setRunning(v) { programRunning = v; },
};
window.App = App;

init();
