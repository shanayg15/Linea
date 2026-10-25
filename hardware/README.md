# Track D: Ana's Desk Beacon (Hardware)

An ambient physical status beacon for the human dispatcher (Ana).

> *"Ana doesn't watch a dashboard. She has a light on her desk. Green means Linea has it. When it turns red, her phone's already ringing."*

---

## 1. How It Works
* **Breathing Green (`IDLE`)**: Linea's autonomous optimizer and Claude dispatcher have full control.
* **White/Cyan Sweep (`THINK`)**: Agent re-plans routes following border wait time changes.
* **Pulsing Red Alarm (`ALERT`)**: Watchdog trips (oscillation, missed driver calls, loop detection).
* **Rapid Red Pulse (`RING`)**: Phone call initiated to dispatcher Ana.
* **Triple Green Flash (`OK`)**: Dispatcher locks in the decision, resolving the trip.

---

## 2. Hardware Bill of Materials
* **Board**: ESP32-S3 (or Arduino Uno / Nano).
* **LED**: 5mm 4-Pin Discrete RGB LED (Common Cathode or Common Anode).
* **Resistors**: 3x 220 ohm to 330 ohm current-limiting resistors.
* **Wiring**:
  * Leg 1 (Red) -> 220 ohm -> ESP32-S3 GPIO 4
  * Leg 2 (Longest pin) -> ESP32-S3 GND (or 3.3V if Common Anode)
  * Leg 3 (Green) -> 220 ohm -> ESP32-S3 GPIO 5
  * Leg 4 (Blue) -> 220 ohm -> ESP32-S3 GPIO 6

---

## 3. Quickstart

### Firmware
Located at `hardware/linea_beacon/linea_beacon.ino`. Flash via Arduino IDE or `arduino-cli`:
```bash
arduino-cli compile --upload -p $(ls /dev/cu.usb* | head -n 1) -b esp32:esp32:esp32s3 hardware/linea_beacon
```

### Bridge Daemon
Connects to Linea's `GET /events` SSE stream and communicates over USB serial at 115200 baud:
```bash
cd hardware
npm install
npm run demo                 # Self-test cycle through all lighting states
npm run send -- ALERT        # One-off command test
npm start                    # Live sync with Linea server (http://localhost:8787/events)
```
