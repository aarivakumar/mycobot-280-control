# myCobot 280 Pi

The myCobot 280 Pi has a Raspberry Pi built into its base. The Pi talks to the arm's
controller over `/dev/ttyAMA0` at 1,000,000 baud. There are two ways to control it:

- **On the Pi itself.** Plug in a monitor, keyboard and mouse, or SSH in. Scripts use the serial port directly.
- **From this PC over the network.** `pi/server.py` runs on the Pi as a TCP bridge
  (port 9000). Scripts on this PC connect with `MyCobot280Socket`.

`robot.py` handles both. If `MYCOBOT_IP` is set (or `--ip` is passed), it uses the network.
On the Pi, it uses the serial port.

```
mycobot/
├── robot.py                  shared connect() helper
├── requirements.txt          pymycobot 4.0.7, pyserial, flask
├── start.sh                  launches the control app
├── webapp/                   control app: connect, joystick, blocks
│   ├── app.py                Flask server, holds the robot connection
│   ├── mock_robot.py         simulated arm for --mock
│   └── static/               index.html, app.js (connect/joystick), blocks.js, vendor/blockly
├── examples/
│   ├── test_connection.py    read-only check, turns the LED green
│   ├── basic_motion.py       moves through a few poses (needs clear space)
│   └── free_move.py          go limp, pose by hand, print angles
└── pi/                       copy this folder to the robot
    ├── server.py             TCP:9000 <-> /dev/ttyAMA0 bridge
    ├── setup_pi.sh           installs deps, optional systemd service
    └── mycobot-server.service
```

## 1. First boot of the robot

1. Plug in the power supply (12V DC barrel jack on the base) and switch it on.
   USB power alone will not drive the servos.
2. Connect a monitor (micro-HDMI), keyboard and mouse. The stock image logs in automatically.
   On older images, the login is `er` / `Elephant`.
3. Connect the Pi to the **same Wi-Fi/LAN as this PC**.
4. Find its IP address by running `hostname -I` in a terminal on the Pi.
5. Optional: enable SSH (`sudo systemctl enable --now ssh`) so the monitor isn't needed again.

## 2. Set up the Pi

From this PC (replace the user and IP with your own):

```bash
scp -r ~/mycobot/pi er@<PI_IP>:~/mycobot-pi
ssh er@<PI_IP> 'bash ~/mycobot-pi/setup_pi.sh --service'
```

This installs `pymycobot`, adds you to the `dialout` group, and runs the bridge as a
service that starts on boot. Reboot the Pi once afterwards.

To run the bridge by hand instead: `python3 ~/mycobot-pi/server.py`

> Only one program can use `/dev/ttyAMA0` at a time. Stop the service
> (`sudo systemctl stop mycobot-server`) before running scripts directly on the Pi,
> or before using myBlockly.

## 3. Control it from this PC

```bash
cd ~/mycobot
source .venv/bin/activate          # already created with pymycobot installed
export MYCOBOT_IP=<PI_IP>

python examples/test_connection.py # safe: reads state, sets LED green
python examples/free_move.py       # pose by hand, watch angles
python examples/basic_motion.py    # moves the arm. Clear the area first.
```

To recreate the environment: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`

## Control app (joystick + blocks)

A browser app with three steps: **connect**, then drive the arm with the
**🕹 Joystick** tab or program it with the **🧩 Blocks** tab. The red **STOP** button
(or **Esc**) stops the arm and any running program.

```bash
cd ~/mycobot
./start.sh                  # open http://localhost:8080
./start.sh --mock           # try everything with a simulated arm
./start.sh --host 0.0.0.0   # also usable from a phone/tablet at http://<this-PC-IP>:8080
```

**1. Connect.** Choose *Over Wi-Fi*, then either type the Pi's IP or press
*Find my robot on this network* (it scans your local network for the bridge on port 9000).
The page checks each step and tells you which one failed: the Pi isn't reachable, or the
Pi answered but the arm didn't (12 V power off). It remembers the last IP.

**2a. Joystick.**
- *Move tool (X Y Z)*: the left stick moves forward/back and left/right, and the right stick moves up/down and twists.
- *Move joints*: the left stick drives J1/J2, the right stick drives J4/J3, and the hold buttons drive J5/J6.
- Speed is set by the slider in the top bar.
- A USB/Bluetooth gamepad works too (A/B gripper, X switches mode, Y home, Start stops),
  and so does the keyboard (W/S, A/D, R/F, Q/E).
- The arm only moves while you hold a control. If the browser stops sending (you let go,
  close the tab or lose Wi-Fi), the arm stops within half a second.
- Save poses in the side panel. You can use them in blocks.

**2b. Blocks.** Drag blocks from *Move*, *Gripper & LED* and *Sensing*, combine them with
loops, logic, variables and functions, then press **▶ Run**. The block that is running
lights up, and each move waits until the arm gets there. Right-click a *move joints* or
*move tool* block → *Fill in current position* to copy where the arm is now (pose it
with the joystick first). Save programs by name. They are stored in `webapp/programs/`.
Your current work is also autosaved in the browser.

**Run the app on the Pi itself** (then any phone or laptop on the network can use it):

```bash
scp -r ~/mycobot er@<PI_IP>:~/mycobot          # the whole folder, not just pi/
ssh er@<PI_IP> 'python3 -m pip install --user flask && ~/mycobot/start.sh --host 0.0.0.0'
# then browse to http://<PI_IP>:8080 and connect to 127.0.0.1 (pre-filled on the Pi)
```

Notes:
- Blockly is stored in `webapp/static/vendor/`, so the app works without internet.
- `--host 0.0.0.0` lets anyone on your network move the arm. There is no login, so
  only use it on a network you trust.
- Targets are clamped to the joint limits below and to the arm's reach. Cartesian moves
  the arm can't reach are ignored by the controller.

## Writing your own scripts

```python
from robot import connect
mc = connect()                         # uses $MYCOBOT_IP, or serial if on the Pi

mc.get_angles()                        # [j1..j6] in degrees
mc.send_angles([0, 0, 0, 0, 0, 0], 30) # angles, speed 1-100
mc.sync_send_angles([...], 30)         # same, but waits until done
mc.get_coords()                        # [x, y, z, rx, ry, rz] (mm, deg)
mc.send_coords([150, -60, 250, -180, 0, -90], 30, 0)
mc.release_all_servos()                # limp, so you can move it by hand
mc.focus_all_servos()                  # lock
mc.set_color(255, 0, 0)                # end LED
mc.set_gripper_state(0, 50)            # 0 = open, 1 = close (if a gripper is fitted)
```

Approximate joint limits in degrees: J1 ±168, J2 ±135, J3 ±150, J4 ±145, J5 ±165, J6 ±180.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ConnectionRefusedError` | The bridge isn't running: `systemctl status mycobot-server` on the Pi |
| Timeout / no route | Wrong IP address, or the PC and Pi are on different networks |
| `get_angles()` returns `-1`, `None` or `[]` | The arm isn't powered (12V), or another program has the serial port |
| Arm doesn't move | Run `mc.power_on()`. Check the servo cables. Update the ATOM firmware with myStudio. |
| Control app says "arm not answering" | The bridge is up but the arm isn't answering: check 12V power, then press Power on |
| `Permission denied: /dev/ttyAMA0` | Run `setup_pi.sh`, then log out/in or reboot |
| Joints drift or zero is wrong | Recalibrate zero positions with myStudio or the official docs |

Official docs: https://docs.elephantrobotics.com/docs/mycobot_280_pi_en/
