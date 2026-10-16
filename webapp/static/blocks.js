"use strict";
// Blockly editor + runner. Programs are turned into async JavaScript and run in the
// browser; each robot block calls the control app's API and waits for the move to finish.

(function () {
  const { api, sleep, toast } = App;
  const gen = javascript.javascriptGenerator;
  const Order = javascript.Order;
  const $ = (id) => document.getElementById(id);

  const JOINTS = [["J1 (base)", "1"], ["J2 (shoulder)", "2"], ["J3 (elbow)", "3"], ["J4 (wrist)", "4"], ["J5 (wrist turn)", "5"], ["J6 (tool spin)", "6"]];
  const AXES = [["x (forward)", "1"], ["y (left)", "2"], ["z (up)", "3"], ["rx", "4"], ["ry", "5"], ["rz", "6"]];
  const ROBOT = 210, GRIP = 30, SENSE = 120;

  const num = (name, value, min, max) => ({ type: "field_number", name, value, min, max, precision: 0.1 });
  const speedField = { type: "field_number", name: "SPEED", value: 50, min: 1, max: 100, precision: 1 };

  // ---------- block definitions ----------
  Blockly.common.defineBlocksWithJsonArray([
    {
      type: "robot_home", message0: "go home at speed %1", args0: [speedField],
      previousStatement: null, nextStatement: null, colour: ROBOT,
      tooltip: "Move every joint to 0°.",
    },
    {
      type: "robot_move_joints",
      message0: "move joints to %1 J1 %2 J2 %3 J3 %4 %5 J4 %6 J5 %7 J6 %8 %9 speed %10",
      args0: [
        { type: "input_dummy" }, num("J1", 0, -168, 168), num("J2", 0, -135, 135), num("J3", 0, -150, 150),
        { type: "input_dummy" }, num("J4", 0, -145, 145), num("J5", 0, -165, 165), num("J6", 0, -180, 180),
        { type: "input_dummy" }, speedField,
      ],
      previousStatement: null, nextStatement: null, colour: ROBOT, extensions: ["fill_current_angles"],
      tooltip: "Move all six joints (degrees). Right-click → Fill in current position.",
    },
    {
      type: "robot_move_joint", message0: "move joint %1 to %2 ° at speed %3",
      args0: [{ type: "field_dropdown", name: "JOINT", options: JOINTS }, { type: "input_value", name: "ANGLE", check: "Number" }, speedField],
      inputsInline: true, previousStatement: null, nextStatement: null, colour: ROBOT,
    },
    {
      type: "robot_turn_joint", message0: "turn joint %1 by %2 °",
      args0: [{ type: "field_dropdown", name: "JOINT", options: JOINTS }, { type: "input_value", name: "DELTA", check: "Number" }],
      inputsInline: true, previousStatement: null, nextStatement: null, colour: ROBOT,
      tooltip: "Turn one joint relative to where it is now.",
    },
    {
      type: "robot_move_tool",
      message0: "move tool to %1 x %2 y %3 z %4 %5 rx %6 ry %7 rz %8 %9 speed %10",
      args0: [
        { type: "input_dummy" }, num("X", 150, -281, 281), num("Y", -60, -281, 281), num("Z", 250, -70, 412),
        { type: "input_dummy" }, num("RX", -180, -180, 180), num("RY", 0, -180, 180), num("RZ", -90, -180, 180),
        { type: "input_dummy" }, speedField,
      ],
      previousStatement: null, nextStatement: null, colour: ROBOT, extensions: ["fill_current_coords"],
      tooltip: "Move the end of the arm to a point (mm) and orientation (degrees).",
    },
    {
      type: "robot_move_tool_by", message0: "move tool %1 by %2 mm",
      args0: [{ type: "field_dropdown", name: "AXIS", options: AXES.slice(0, 3) }, { type: "input_value", name: "DELTA", check: "Number" }],
      inputsInline: true, previousStatement: null, nextStatement: null, colour: ROBOT,
    },
    {
      type: "robot_go_pose", message0: "go to saved pose %1 at speed %2",
      args0: [{ type: "input_dummy", name: "POSE_IN" }, speedField],
      previousStatement: null, nextStatement: null, colour: ROBOT, extensions: ["pose_dropdown"],
      tooltip: "Save poses from the Joystick tab.",
    },
    {
      type: "robot_wait", message0: "wait %1 seconds",
      args0: [{ type: "input_value", name: "SECS", check: "Number" }],
      inputsInline: true, previousStatement: null, nextStatement: null, colour: ROBOT,
    },
    {
      type: "robot_gripper", message0: "%1 gripper",
      args0: [{ type: "field_dropdown", name: "STATE", options: [["open", "100"], ["close", "0"]] }],
      previousStatement: null, nextStatement: null, colour: GRIP,
    },
    {
      type: "robot_gripper_value", message0: "set gripper to %1 % open",
      args0: [{ type: "input_value", name: "VALUE", check: "Number" }],
      inputsInline: true, previousStatement: null, nextStatement: null, colour: GRIP,
    },
    {
      type: "robot_led", message0: "set LED red %1 green %2 blue %3",
      args0: [{ type: "input_value", name: "R", check: "Number" }, { type: "input_value", name: "G", check: "Number" }, { type: "input_value", name: "B", check: "Number" }],
      inputsInline: true, previousStatement: null, nextStatement: null, colour: GRIP,
      tooltip: "Each colour is 0-255.",
    },
    {
      type: "robot_servos", message0: "%1 all servos",
      args0: [{ type: "field_dropdown", name: "STATE", options: [["lock", "1"], ["relax", "0"]] }],
      previousStatement: null, nextStatement: null, colour: GRIP,
      tooltip: "Relax makes the arm go limp. Hold it first!",
    },
    {
      type: "robot_get_angle", message0: "angle of joint %1",
      args0: [{ type: "field_dropdown", name: "JOINT", options: JOINTS }], output: "Number", colour: SENSE,
    },
    {
      type: "robot_get_coord", message0: "tool position %1",
      args0: [{ type: "field_dropdown", name: "AXIS", options: AXES }], output: "Number", colour: SENSE,
    },
    {
      type: "robot_say", message0: "say %1", args0: [{ type: "input_value", name: "TEXT" }],
      previousStatement: null, nextStatement: null, colour: SENSE, tooltip: "Show a message in the Output panel.",
    },
  ]);

  // Right-click → "Fill in current position"
  function fillMixin(fields, key) {
    return function () {
      this.customContextMenu = (options) => {
        options.unshift({
          text: "Fill in current position",
          enabled: !!App.state[key],
          callback: () => fields.forEach((f, i) => this.setFieldValue(Math.round(App.state[key][i] * 10) / 10, f)),
        });
      };
    };
  }
  Blockly.Extensions.register("fill_current_angles", fillMixin(["J1", "J2", "J3", "J4", "J5", "J6"], "angles"));
  Blockly.Extensions.register("fill_current_coords", fillMixin(["X", "Y", "Z", "RX", "RY", "RZ"], "coords"));
  Blockly.Extensions.register("pose_dropdown", function () {
    this.getInput("POSE_IN").appendField(new Blockly.FieldDropdown(() => {
      const names = Object.keys(App.poses);
      return names.length ? names.map((n) => [n, n]) : [["(no saved poses)", ""]];
    }), "POSE");
  });

  // ---------- code generators ----------
  const val = (b, name, dflt) => gen.valueToCode(b, name, Order.NONE) || dflt;
  const f = (b, name) => JSON.stringify(b.getFieldValue(name));
  const G = gen.forBlock;
  G.robot_home = (b) => `await R.angles([0,0,0,0,0,0], ${f(b, "SPEED")});\n`;
  G.robot_move_joints = (b) => `await R.angles([${["J1", "J2", "J3", "J4", "J5", "J6"].map((k) => b.getFieldValue(k)).join(",")}], ${f(b, "SPEED")});\n`;
  G.robot_move_joint = (b) => `await R.joint(${b.getFieldValue("JOINT")}, ${val(b, "ANGLE", 0)}, ${f(b, "SPEED")});\n`;
  G.robot_turn_joint = (b) => `await R.turnJoint(${b.getFieldValue("JOINT")}, ${val(b, "DELTA", 0)});\n`;
  G.robot_move_tool = (b) => `await R.coords([${["X", "Y", "Z", "RX", "RY", "RZ"].map((k) => b.getFieldValue(k)).join(",")}], ${f(b, "SPEED")});\n`;
  G.robot_move_tool_by = (b) => `await R.moveToolBy(${b.getFieldValue("AXIS")}, ${val(b, "DELTA", 0)});\n`;
  G.robot_go_pose = (b) => `await R.pose(${f(b, "POSE")}, ${f(b, "SPEED")});\n`;
  G.robot_wait = (b) => `await R.wait(${val(b, "SECS", 1)});\n`;
  G.robot_gripper = (b) => `await R.gripper(${b.getFieldValue("STATE")});\n`;
  G.robot_gripper_value = (b) => `await R.gripper(${val(b, "VALUE", 50)});\n`;
  G.robot_led = (b) => `await R.led(${val(b, "R", 0)}, ${val(b, "G", 0)}, ${val(b, "B", 0)});\n`;
  G.robot_servos = (b) => `await R.servos(${b.getFieldValue("STATE") === "1"});\n`;
  G.robot_get_angle = (b) => [`(await R.getAngle(${b.getFieldValue("JOINT")}))`, Order.ATOMIC];
  G.robot_get_coord = (b) => [`(await R.getCoord(${b.getFieldValue("AXIS")}))`, Order.ATOMIC];
  G.robot_say = (b) => `R.say(${val(b, "TEXT", "''")});\n`;
  G.text_print = G.robot_say;

  // User-defined functions must be async so robot blocks inside them can await.
  const callNo = G.procedures_callnoreturn, callRet = G.procedures_callreturn;
  G.procedures_callnoreturn = function (b, g) { return "await " + callNo.call(this, b, g); };
  G.procedures_callreturn = function (b, g) { return ["(await " + callRet.call(this, b, g)[0] + ")", Order.ATOMIC]; };

  gen.STATEMENT_PREFIX = "await R.step(%1);\n";   // highlight + stop check before every block
  gen.INFINITE_LOOP_TRAP = "await R.tick();\n";   // lets Stop break out of loops
  gen.addReservedWords("R");

  // ---------- toolbox ----------
  const n = (v) => ({ shadow: { type: "math_number", fields: { NUM: v } } });
  const toolbox = {
    kind: "categoryToolbox",
    contents: [
      { kind: "category", name: "Move", colour: ROBOT, contents: [
        { kind: "block", type: "robot_home" },
        { kind: "block", type: "robot_move_joints" },
        { kind: "block", type: "robot_move_joint", inputs: { ANGLE: n(30) } },
        { kind: "block", type: "robot_turn_joint", inputs: { DELTA: n(20) } },
        { kind: "block", type: "robot_move_tool" },
        { kind: "block", type: "robot_move_tool_by", inputs: { DELTA: n(20) } },
        { kind: "block", type: "robot_go_pose" },
        { kind: "block", type: "robot_wait", inputs: { SECS: n(1) } },
      ] },
      { kind: "category", name: "Gripper & LED", colour: GRIP, contents: [
        { kind: "block", type: "robot_gripper" },
        { kind: "block", type: "robot_gripper_value", inputs: { VALUE: n(50) } },
        { kind: "block", type: "robot_led", inputs: { R: n(0), G: n(255), B: n(0) } },
        { kind: "block", type: "robot_servos" },
      ] },
      { kind: "category", name: "Sensing", colour: SENSE, contents: [
        { kind: "block", type: "robot_get_angle" },
        { kind: "block", type: "robot_get_coord" },
        { kind: "block", type: "robot_say", inputs: { TEXT: { shadow: { type: "text", fields: { TEXT: "Hello!" } } } } },
      ] },
      { kind: "sep" },
      { kind: "category", name: "Logic", categorystyle: "logic_category", contents: [
        "controls_if", "logic_compare", "logic_operation", "logic_negate", "logic_boolean",
      ].map((type) => ({ kind: "block", type })) },
      { kind: "category", name: "Loops", categorystyle: "loop_category", contents: [
        { kind: "block", type: "controls_repeat_ext", inputs: { TIMES: n(3) } },
        { kind: "block", type: "controls_whileUntil" },
        { kind: "block", type: "controls_for", inputs: { FROM: n(1), TO: n(5), BY: n(1) } },
        { kind: "block", type: "controls_flow_statements" },
      ] },
      { kind: "category", name: "Math", categorystyle: "math_category", contents: [
        { kind: "block", type: "math_number" },
        { kind: "block", type: "math_arithmetic", inputs: { A: n(1), B: n(1) } },
        { kind: "block", type: "math_random_int", inputs: { FROM: n(-30), TO: n(30) } },
        { kind: "block", type: "math_single" },
        { kind: "block", type: "math_round" },
      ] },
      { kind: "category", name: "Text", categorystyle: "text_category", contents: [
        { kind: "block", type: "text" },
        { kind: "block", type: "text_join" },
      ] },
      { kind: "category", name: "Variables", categorystyle: "variable_category", custom: "VARIABLE" },
      { kind: "category", name: "Functions", categorystyle: "procedure_category", custom: "PROCEDURE" },
    ],
  };

  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const ws = Blockly.inject("blockly", {
    toolbox,
    theme: dark ? Blockly.Themes.Classic && Blockly.Theme.defineTheme("dark", {
      base: Blockly.Themes.Classic,
      componentStyles: {
        workspaceBackgroundColour: "#14171f", toolboxBackgroundColour: "#1d212b", toolboxForegroundColour: "#e7e9ee",
        flyoutBackgroundColour: "#252a36", flyoutForegroundColour: "#e7e9ee", scrollbarColour: "#4a5163",
      },
    }) : Blockly.Themes.Classic,
    trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.9 },
    move: { scrollbars: true, drag: true, wheel: false },
    grid: { spacing: 24, length: 2, colour: dark ? "#262b37" : "#e3e6ec", snap: true },
  });
  window.addEventListener("resize", () => Blockly.svgResize(ws));

  // ---------- example / autosave ----------
  const EXAMPLE = { blocks: { languageVersion: 0, blocks: [{
    type: "robot_say", x: 40, y: 40,
    inputs: { TEXT: { shadow: { type: "text", fields: { TEXT: "Wave hello!" } } } },
    next: { block: { type: "robot_home", fields: { SPEED: 50 },
      next: { block: { type: "controls_repeat_ext", inputs: { TIMES: { shadow: { type: "math_number", fields: { NUM: 3 } } },
        DO: { block: { type: "robot_move_joint", fields: { JOINT: "1", SPEED: 60 }, inputs: { ANGLE: { shadow: { type: "math_number", fields: { NUM: 30 } } } },
          next: { block: { type: "robot_move_joint", fields: { JOINT: "1", SPEED: 60 }, inputs: { ANGLE: { shadow: { type: "math_number", fields: { NUM: -30 } } } } } } } } },
        next: { block: { type: "robot_home", fields: { SPEED: 50 },
          next: { block: { type: "robot_say", inputs: { TEXT: { shadow: { type: "text", fields: { TEXT: "Done" } } } } } } } } } } } },
  }] } };

  function loadJson(json) {
    ws.clear();
    try { Blockly.serialization.workspaces.load(json, ws); }
    catch (e) { toast("Couldn't load that program: " + e.message); }
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("blocks-autosave")); } catch (e) { /* none */ }
  loadJson(saved || EXAMPLE);
  try { $("prog-name").value = localStorage.getItem("blocks-name") || "My program"; } catch (e) { /* none */ }
  ws.addChangeListener((e) => {
    if (e.isUiEvent) return;
    try { localStorage.setItem("blocks-autosave", JSON.stringify(Blockly.serialization.workspaces.save(ws))); } catch (err) { /* full/private */ }
  });

  // ---------- output panel ----------
  function log(text, cls) {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    $("log").appendChild(li);
    li.scrollIntoView({ block: "nearest" });
  }

  // ---------- runtime ----------
  class Stopped extends Error {}
  let stopped = false;
  App.onStop.push(() => { stopped = true; });
  const check = () => { if (stopped) throw new Stopped(); };

  async function call(path, body) {
    check();
    try { return await api(path, body, "POST", true); }
    catch (e) { throw new Error(e.message); }
  }

  const maxDiff = (a, b, n) => Math.max(...a.slice(0, n).map((v, i) => Math.abs(v - b[i])));

  // Wait until the arm reaches the target, or stops moving. key = "angles" or "coords".
  async function settle(key, target) {
    const n = key === "angles" ? 6 : 3;
    const tol = key === "angles" ? 2 : 5;
    const t0 = Date.now();
    let last = null, lastUpdate = null, still = 0;
    await sleep(250);
    while (Date.now() - t0 < 30000) {
      check();
      const s = App.state;
      const cur = s[key];
      if (!cur) {
        if (Date.now() - t0 > 4000) throw new Error("The arm isn't replying. Is the 12 V power on?");
      } else if (s.updated !== lastUpdate) {
        if (target && maxDiff(cur, target, n) < tol) return;
        still = last && maxDiff(cur, last, n) < 0.3 ? still + 1 : 0;
        if (still >= 3 && Date.now() - t0 > 1000) return;  // stopped short (e.g. unreachable)
        last = cur;
        lastUpdate = s.updated;
      }
      await sleep(100);
    }
  }

  async function fresh(key) {
    const s = await (await fetch("/api/state")).json();
    if (!s[key]) throw new Error("Can't read the arm's position. Is the 12 V power on?");
    return s[key];
  }

  const LIMITS = () => App.config.joint_limits;
  const clampJ = (j, a) => Math.max(LIMITS()[j - 1][0], Math.min(LIMITS()[j - 1][1], a));
  const R = {
    async step(id) {
      check();
      ws.highlightBlock(id);
      await sleep(0);
    },
    async tick() { check(); await sleep(0); },
    async angles(a, sp) {
      const t = a.map((v, i) => clampJ(i + 1, Number(v)));
      await call("/api/angles", { angles: t, speed: sp });
      await settle("angles", t);
    },
    async joint(j, angle, sp) {
      const t = (await fresh("angles")).slice();
      t[j - 1] = clampJ(j, Number(angle));
      await call("/api/angle", { joint: j, angle: t[j - 1], speed: sp });
      await settle("angles", t);
    },
    async turnJoint(j, delta) {
      const t = (await fresh("angles")).slice();
      t[j - 1] = clampJ(j, t[j - 1] + Number(delta));
      await call("/api/angle", { joint: j, angle: t[j - 1], speed: App.speed() });
      await settle("angles", t);
    },
    async coords(c, sp) {
      await call("/api/coords", { coords: c, speed: sp });
      await settle("coords", c);
    },
    async moveToolBy(axis, delta) {
      const t = (await fresh("coords")).slice();
      t[axis - 1] += Number(delta);
      await call("/api/jog_coord", { axis, delta: Number(delta), speed: App.speed() });
      await settle("coords", t);
    },
    async pose(name, sp) {
      const a = App.poses[name];
      if (!a) throw new Error(`No saved pose called "${name}". Save one in the Joystick tab.`);
      await R.angles(a, sp);
    },
    async wait(s) {
      const end = Date.now() + Number(s) * 1000;
      while (Date.now() < end) { check(); await sleep(Math.min(100, end - Date.now())); }
    },
    async gripper(v) { await call("/api/gripper", { value: Number(v), speed: App.speed() }); await R.wait(0.8); },
    async led(r, g, b) { await call("/api/color", { r, g, b }); },
    async servos(locked) { await call("/api/servos", { locked }); },
    async getAngle(j) { return (await fresh("angles"))[j - 1]; },
    async getCoord(a) { return (await fresh("coords"))[a - 1]; },
    say(text) { log(String(text)); },
  };

  let running = false;
  async function run() {
    if (running) return;
    if (!App.state.connected) { toast("Connect to the robot first."); return; }
    const code = gen.workspaceToCode(ws).replace(/^function (\w+)\(/gm, "async function $1(");
    running = true;
    stopped = false;
    App.setRunning(true);
    $("run").disabled = true;
    $("halt").disabled = false;
    log("▶ Running " + $("prog-name").value, "sys");
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction("R", code)(R);
      log("✓ Finished", "sys");
    } catch (e) {
      if (e instanceof Stopped) log("■ Stopped", "sys");
      else { log("✗ " + e.message, "err"); console.error(e, "\n" + code); }
    } finally {
      running = false;
      App.setRunning(false);
      ws.highlightBlock(null);
      $("run").disabled = false;
      $("halt").disabled = true;
    }
  }

  // ---------- save / open ----------
  async function refreshList() {
    try {
      const names = await api("/api/programs");
      const sel = $("prog-list");
      sel.innerHTML = '<option value="">Open…</option>' + names.map((nm) => `<option>${nm.replace(/</g, "&lt;")}</option>`).join("");
    } catch (e) { /* shown */ }
  }
  async function saveProgram() {
    const name = $("prog-name").value.trim();
    try {
      const r = await api("/api/programs/" + encodeURIComponent(name), Blockly.serialization.workspaces.save(ws), "PUT");
      $("prog-name").value = r.name;
      try { localStorage.setItem("blocks-name", r.name); } catch (e) { /* ignore */ }
      toast(`Saved "${r.name}"`, "info");
      refreshList();
    } catch (e) { /* shown */ }
  }
  async function openProgram(name) {
    if (!name) return;
    try {
      loadJson(await api("/api/programs/" + encodeURIComponent(name)));
      $("prog-name").value = name;
      try { localStorage.setItem("blocks-name", name); } catch (e) { /* ignore */ }
    } catch (e) { /* shown */ }
    $("prog-list").value = "";
  }

  $("run").onclick = run;
  $("halt").onclick = App.stopAll;
  $("prog-save").onclick = saveProgram;
  $("prog-list").onchange = (e) => openProgram(e.target.value);
  $("prog-new").onclick = () => {
    if (!confirm("Start a new program? Unsaved changes will be lost.")) return;
    loadJson(EXAMPLE);
    $("prog-name").value = "My program";
  };
  refreshList();
})();
