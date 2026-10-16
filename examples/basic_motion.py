"""Move through a few safe poses and return to zero. Clear space around the arm first!"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from robot import connect_from_args

SPEED = 30  # 1-100; keep low while testing

POSES = [
    [0, 0, 0, 0, 0, 0],
    [30, -20, -30, 20, 0, 0],
    [-30, -20, -30, 20, 0, 0],
    [0, 0, 0, 0, 0, 0],
]

mc = connect_from_args(__doc__)
mc.power_on()
time.sleep(1)

for pose in POSES:
    print("->", pose)
    mc.sync_send_angles(pose, SPEED, timeout=10)
    print("   now at", mc.get_angles())

print("Done.")
