#!/usr/bin/env bash
# Get the dashboard to the demo's starting point: reset the shift, run at 60x to 2:45 PM sim, pause.
# Usage: npm run demo:prep            (or: bash scripts/demo-prep.sh 14:40)
set -euo pipefail
API="${LINEA_API:-http://localhost:8787}"
AT="${1:-14:45}"

post() { curl -sf -X POST "$API/control" -H 'content-type: application/json' -d "$1" >/dev/null; }
simtime() { curl -sf "$API/health" | sed -E 's/.*"simTime":"[0-9-]+T([0-9]{2}:[0-9]{2}).*/\1/'; }

curl -sf "$API/health" >/dev/null || { echo "Server not reachable at $API — run 'npm start' first."; exit 1; }
post '{"cmd":"reset"}'
post '{"cmd":"speed","value":60}'
post '{"cmd":"play"}'
echo "Running the shift to $AT PM sim time (about a minute)..."
while true; do
  t="$(simtime)"
  if [[ "$t" > "$AT" || "$t" == "$AT" ]]; then break; fi
  sleep 0.25
done
post '{"cmd":"pause"}'
echo "Paused at $(simtime). Carlos (Truck 4) is in the Otay line. Press Space in the dashboard to start."
