#!/usr/bin/env bash
# Get the dashboard to the demo's starting point instantly: reset the shift, jump to 2:45 PM sim time, pause.
# Usage: npm run demo:prep            (or: bash scripts/demo-prep.sh 14:40)
set -euo pipefail
API="${LINEA_API:-http://localhost:8787}"
AT="${1:-14:45}"

post() { curl -sf -X POST "$API/control" -H 'content-type: application/json' -d "$1" >/dev/null; }

curl -sf "$API/health" >/dev/null || { echo "Server not reachable at $API — run 'npm start' first."; exit 1; }
post '{"cmd":"reset"}'
post '{"cmd":"speed","value":60}'
post "{\"cmd\":\"jump\",\"to\":\"$AT\"}"
t="$(curl -sf "$API/health" | sed -E 's/.*"simTime":"[0-9-]+T([0-9]{2}:[0-9]{2}).*/\1/')"
echo "Paused at $t. Carlos (Truck 4) is in the Otay line. Press Space in the dashboard to start."
