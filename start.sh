#!/usr/bin/env bash
# Start the myCobot control app:
#   ./start.sh                  this PC only, then open http://localhost:8080
#   ./start.sh --host 0.0.0.0   also reachable from phones/tablets on your network
#   ./start.sh --mock           try it without a robot
cd "$(dirname "$0")"
PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
exec "$PY" webapp/app.py "$@"
