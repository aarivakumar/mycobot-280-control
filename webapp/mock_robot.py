"""A fake myCobot 280 for trying the web app without hardware (--mock).

Moves are interpolated over time so the UI shows motion. Coordinates are
tracked separately from angles (no real kinematics).
"""
import time

HOME_COORDS = [156.7, -63.6, 304.4, -175.0, 0.0, -90.0]


class MockMyCobot:
    DEG_PER_SEC_AT_SPEED_100 = 160.0

    def __init__(self):
        self._start = [0.0] * 6
        self._target = [0.0] * 6
        self._t0 = 0.0
        self._duration = 0.0
        self._coords = list(HOME_COORDS)
        self._powered = True
        self._gripper = 0

    def _now_angles(self):
        if self._duration <= 0:
            return list(self._target)
        f = min(1.0, (time.time() - self._t0) / self._duration)
        return [s + (t - s) * f for s, t in zip(self._start, self._target)]

    def _move_to(self, angles, speed):
        self._start = self._now_angles()
        self._target = [float(a) for a in angles]
        dist = max(abs(t - s) for s, t in zip(self._start, self._target))
        self._duration = dist / (self.DEG_PER_SEC_AT_SPEED_100 * max(speed, 1) / 100.0)
        self._t0 = time.time()

    # --- the subset of the pymycobot API the web app uses ---
    def get_angles(self):
        return [round(a, 2) for a in self._now_angles()] if self._powered else -1

    def get_coords(self):
        return list(self._coords)

    def send_angles(self, angles, speed):
        self._move_to(angles, speed)

    def send_angle(self, joint, degree, speed):
        angles = self._now_angles()
        angles[joint - 1] = degree
        self._move_to(angles, speed)

    def send_coords(self, coords, speed, mode=0):
        self._coords = [float(c) for c in coords]

    def send_coord(self, axis, value, speed):
        self._coords[axis - 1] = float(value)

    def stop(self):
        self._target = self._now_angles()
        self._duration = 0

    def is_moving(self):
        return 1 if self._duration and time.time() - self._t0 < self._duration else 0

    def power_on(self):
        self._powered = True

    def power_off(self):
        self._powered = False

    def is_power_on(self):
        return 1 if self._powered else 0

    def release_all_servos(self):
        pass

    def focus_all_servos(self):
        pass

    def set_color(self, r, g, b):
        pass

    def set_gripper_value(self, value, speed):
        self._gripper = value

    def get_gripper_value(self):
        return self._gripper

    def get_system_version(self):
        return "mock"

    def close(self):
        pass
