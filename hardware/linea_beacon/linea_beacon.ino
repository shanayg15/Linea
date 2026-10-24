// linea_beacon.ino - Ana's desk beacon for Linea
// Target: ESP32-S3 with 4-pin Discrete RGB LED (Common Cathode)
#include <Arduino.h>

// ==============================================================================
// 1. HARDWARE CONFIGURATION
// ==============================================================================
#define USE_NEOPIXEL     0      // 0 = 4-pin discrete RGB LED (ECE 5 kit), 1 = NeoPixel WS2812B
#define COMMON_ANODE     0      // 0 = Common Cathode (longest pin to GND), 1 = Common Anode (longest pin to 3.3V)

// ESP32-S3 GPIO Pin Assignments (Adjacent low-noise pins)
#define RGB_R            4      // ESP32-S3 GPIO 4 -> 220 ohm resistor -> Red pin
#define RGB_G            5      // ESP32-S3 GPIO 5 -> 220 ohm resistor -> Green pin
#define RGB_B            6      // ESP32-S3 GPIO 6 -> 220 ohm resistor -> Blue pin

#define LED_PIN          6      // (Only used if USE_NEOPIXEL == 1)
#define NUM_LEDS         16     // (Only used if USE_NEOPIXEL == 1)
#define MAX_BRIGHT       255    // 0-255 scaling factor
#define BAUD             115200 // Native USB CDC baud rate

#define ENABLE_WIFI      0      // 0 = USB Serial bridge mode, 1 = Direct Wi-Fi

// ==============================================================================
// 2. BEACON MODES & PALETTES
// ==============================================================================
enum Mode { M_IDLE, M_THINK, M_ALERT, M_RING, M_OK, M_OFF };
Mode mode = M_IDLE;
unsigned long modeStart = 0;
String inbuf = "";

void setMode(Mode m) {
  mode = m;
  modeStart = millis();
}

// Write duty cycle (0-255) with Common Anode / Common Cathode handling
void writePWM(uint8_t pin, uint8_t duty) {
#if COMMON_ANODE
  duty = 255 - duty;
#endif
  analogWrite(pin, duty);
}

void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  writePWM(RGB_R, r);
  writePWM(RGB_G, g);
  writePWM(RGB_B, b);
}

// Organic respiration curve: returns 0.0 to 1.0 smoothly
float breatheCurve(unsigned long t, float periodMs) {
  float theta = ((float)(t % (unsigned long)periodMs) / periodMs) * 2.0f * PI;
  float val = exp(sin(theta));
  float norm = (val - 0.367879f) * 0.425459f;
  if (norm < 0.0f) norm = 0.0f;
  if (norm > 1.0f) norm = 1.0f;
  return norm;
}

float sineWave(unsigned long t, float periodMs) {
  return 0.5f + 0.5f * sin(((float)t / periodMs) * 2.0f * PI);
}

void render() {
  unsigned long t = millis() - modeStart;
  switch (mode) {
    case M_IDLE: {
      // VIBRANT GREEN BREATHING: Duty cycle breathes between 60 (clear glow) and 255 (full bright)
      float b = breatheCurve(t, 3500.0f);
      uint8_t gVal = (uint8_t)(60.0f + 195.0f * b);
      setRGB(0, gVal, 0);
      break;
    }

    case M_THINK: {
      // White/Cyan pulse for 700 ms during route re-planning
      float s = sineWave(t, 700.0f);
      uint8_t cVal = (uint8_t)(80.0f + 175.0f * s);
      setRGB((uint8_t)(cVal * 0.7f), cVal, cVal);
      if (t > 700) setMode(M_IDLE);
      break;
    }

    case M_ALERT: {
      // VIBRANT RED ALARM: Deep emergency breathing between 90 and 255
      float b = breatheCurve(t, 1400.0f);
      uint8_t rVal = (uint8_t)(90.0f + 165.0f * b);
      setRGB(rVal, 0, 0);
      break;
    }

    case M_RING: {
      // URGENT PHONE RINGING: 2 Hz double-flash cadence
      unsigned long sub = t % 1000;
      bool on = (sub < 200) || (sub >= 350 && sub < 550);
      setRGB(on ? 255 : 0, 0, 0);
      break;
    }

    case M_OK: {
      // 3 CRISP GREEN CONFIRMATION FLASHES
      bool on = ((t / 150) % 2) == 0;
      setRGB(0, on ? 255 : 0, 0);
      if (t > 900) setMode(M_IDLE);
      break;
    }

    case M_OFF:
      setRGB(0, 0, 0);
      break;
  }
}

// ==============================================================================
// 3. COMMAND HANDLER
// ==============================================================================
void handleCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if      (cmd == "IDLE")  setMode(M_IDLE);
  else if (cmd == "THINK") setMode(M_THINK);
  else if (cmd == "ALERT") setMode(M_ALERT);
  else if (cmd == "RING")  setMode(M_RING);
  else if (cmd == "OK")    setMode(M_OK);
  else if (cmd == "OFF")   setMode(M_OFF);
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
// 4. SETUP WITH VISUAL STARTUP SELF-TEST
// ==============================================================================
void setup() {
  Serial.begin(BAUD);

  pinMode(RGB_R, OUTPUT);
  pinMode(RGB_G, OUTPUT);
  pinMode(RGB_B, OUTPUT);

  // STARTUP RGB SELF-TEST: Flash RED -> GREEN -> BLUE for 400ms each
  // This visually proves the wiring and pins immediately upon power-up!
  setRGB(255, 0, 0); delay(400); // RED
  setRGB(0, 255, 0); delay(400); // GREEN
  setRGB(0, 0, 255); delay(400); // BLUE
  setRGB(0, 0, 0);   delay(200); // OFF

  setMode(M_IDLE);
  Serial.println("LINEA_BEACON_READY");
}

void loop() {
  readSerial();
  render();
  delay(16); // ~60 FPS update rate
}
