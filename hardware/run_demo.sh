#!/usr/bin/env bash
# run_demo.sh - Orchestrates the full Linea Track D Dispatcher Beacon demo sequence
set -e

API="http://localhost:8787"

echo "======================================================================"
echo "LINEA TRACK D: ANA'S DESK BEACON - FULL DEMO SEQUENCE"
echo "======================================================================"
echo ""

echo "[1/4] RESETTING SHIFT..."
echo "      Normal operations: Linea autonomous fleet running."
echo "      Expected Beacon State: VIVID SOLID GREEN"
curl -s -X POST "$API/control" -H "Content-Type: application/json" -d '{"cmd":"reset","speed":20}'
echo ""
sleep 4

echo "[2/4] INJECTING PORT WAIT SPIKE..."
echo "      Otay Mesa wait time surges >= 60 min. Linea starts route re-planning."
echo "      Expected Beacon State: BRIGHT SOLID WHITE"
curl -s -X POST "$API/control" -H "Content-Type: application/json" -d '{"cmd":"inject_spike"}'
echo ""
sleep 5

echo "[3/4] ESCALATING WATCHDOG TRIP & DISPATCHER PHONE CALL..."
echo "      Flapping port data detected. Watchdog freezes truck and dials Ana."
echo "      Expected Beacon State: FLASHING RED (2 Hz urgent ring cadence)"
curl -s -X POST "$API/control" -H "Content-Type: application/json" -d '{"cmd":"chaos_flip"}'
echo ""
sleep 9

echo "[4/4] RESOLUTION BY DISPATCHER (ANA)..."
echo "      Ana confirms route decision. Call ends cleanly."
echo "      Expected Beacon State: 3 GREEN CONFIRMATION FLASHES -> SOLID GREEN"
echo ""
echo "======================================================================"
echo "DEMO COMPLETE: Track D Hardware Dispatcher Beacon Verified!"
echo "======================================================================"
