"""Read-only check that the arm is reachable. Does not move the robot."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from robot import connect_from_args

mc = connect_from_args(__doc__)
print("controller connected:", mc.is_controller_connected())
print("powered on:          ", mc.is_power_on())
print("firmware version:    ", mc.get_system_version())
print("joint angles (deg):  ", mc.get_angles())
print("end coords:          ", mc.get_coords())
mc.set_color(0, 255, 0)  # LED on the end turns green
print("LED set to green - if it changed, you're connected.")
