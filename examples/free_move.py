"""Release the servos so you can pose the arm by hand; prints joint angles live.

Hold the arm when you start - it goes limp. Press Ctrl+C to lock it in place again.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from robot import connect_from_args

mc = connect_from_args(__doc__)
input("Support the arm with your hand, then press Enter to release the servos...")
mc.release_all_servos()
try:
    while True:
        print("angles:", mc.get_angles(), end="\r", flush=True)
        time.sleep(0.3)
except KeyboardInterrupt:
    print("\nLocking servos.")
    mc.focus_all_servos()
