// linea_beacon.ino - Ana's desk beacon for Linea
// Target: ESP32-S3 with 4-pin Discrete RGB LED (Common Cathode)
#include <Arduino.h>

// ==============================================================================
// 1. HARDWARE CONFIGURATION
// ==============================================================================
#define COMMON_ANODE     0      // 0 = Common Cathode (longest pin to GND), 1 = Common Anode (longest pin to 3.3V)

// ESP32-S3 GPIO Pin Assignments
#define RGB_R            4      // ESP32-S3 GPIO 4 -> 220 ohm resistor -> Red pin
#define RGB_G            5      // ESP32-S3 GPIO 5 -> 220 ohm resistor -> Green pin
#define RGB_B            6      // ESP32-S3 GPIO 6 -> 220 ohm resistor -> Blue pin

#define BAUD             115200 // Serial communication baud rate

// ==============================================================================
// 2. BEACON MODES
// ==============================================================================
enum Mode {
  M_GREEN,  // Start: Linea autonomous control (Bright Green)
  M_WHITE,  // Re-planning / Waiting after spike (Bright White)
  M_RING,   // Phone ringing / Watchdog trip (Flashing Red at 2 Hz)
  M_ALERT,  // Emergency on call (Solid Red)
  M_OK,     // Decision resolved (3 Green confirmation flashes -> returns to Green)
  M_OFF     // Dark
};

Mode mode = M_GREEN;
unsigned long modeStart = 0;
String inbuf = "";

void setMode(Mode m) {
  mode = m;
  modeStart = millis();
}

// Drive RGB LED (0 = off, 1 = on) with Common Cathode / Common Anode handling
void drivePins(bool r, bool g, bool b) {
#if COMMON_ANODE
  r = !r;
  g = !g;
  b = !b;
#endif
  digitalWrite(RGB_R, r ? HIGH : LOW);
  digitalWrite(RGB_G, g ? HIGH : LOW);
  digitalWrite(RGB_B, b ? HIGH : LOW);
}

// ==============================================================================
// 3. RENDER LOOP
// ==============================================================================
void render() {
  unsigned long t = millis() - modeStart;

  switch (mode) {
    case M_GREEN:
      // Start: Solid, vivid Green
      drivePins(false, true, false);
      break;

    case M_WHITE:
      // Spike / Re-planning: Solid bright White (Red + Green + Blue)
      drivePins(true, true, true);
      break;

    case M_RING: {
      // Call ringing: Flashing Red at 2 Hz (250ms ON, 250ms OFF)
      bool on = (t % 500) < 250;
      drivePins(on, false, false);
      break;
    }

    case M_ALERT:
      // Solid Red warning
      drivePins(true, false, false);
      break;

    case M_OK: {
      // 3 crisp Green flashes (150ms ON, 150ms OFF)
      bool on = ((t / 150) % 2) == 0;
      drivePins(false, on, false);
      if (t > 900) setMode(M_GREEN);
      break;
    }

    case M_OFF:
      drivePins(false, false, false);
      break;
  }
}

// ==============================================================================
// 4. COMMAND HANDLER
// ==============================================================================
void handleCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if      (cmd == "IDLE" || cmd == "GREEN") setMode(M_GREEN);
  else if (cmd == "WHITE" || cmd == "THINK") setMode(M_WHITE);
  else if (cmd == "RING")                   setMode(M_RING);
  else if (cmd == "ALERT")                  setMode(M_RING); // Flashes red on alert
  else if (cmd == "OK")                     setMode(M_OK);
  else if (cmd == "OFF")                    setMode(M_OFF);
  else {
    Serial.print("ERR ");
    Serial.println(cmd);
    return;
  }
  Serial.print("ACK ");
  Serial.println(cmd);
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inbuf.length() > 0) {
        handleCommand(inbuf);
        inbuf = "";
      }
    } else if (inbuf.length() < 32) {
      inbuf += c;
    }
  }
}

// ==============================================================================
// 5. SETUP
// ==============================================================================
void setup() {
  Serial.begin(BAUD);

  pinMode(RGB_R, OUTPUT);
  pinMode(RGB_G, OUTPUT);
  pinMode(RGB_B, OUTPUT);

  // STARTUP PROOF: Quick confirmation blink (Red -> Green -> Blue -> Green)
  drivePins(true, false, false); delay(300); // Red
  drivePins(false, true, false); delay(300); // Green
  drivePins(false, false, true); delay(300); // Blue
  drivePins(false, true, false);             // Start at GREEN

  setMode(M_GREEN);
  Serial.println("LINEA_BEACON_READY");
}

void loop() {
  readSerial();
  render();
  delay(10);
}
