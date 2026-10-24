// linea_beacon.ino - Ana's desk beacon for Linea
// Target: ESP32-S3 (or Arduino Nano/Uno) with 4-pin RGB LED (or NeoPixel)
#include <Arduino.h>

// ==============================================================================
// 1. HARDWARE CONFIGURATION
// ==============================================================================
#define USE_NEOPIXEL     0      // 0 = 4-pin discrete RGB LED (ECE 5 kit), 1 = NeoPixel WS2812B
#define COMMON_ANODE     0      // 0 = Common Cathode (longest pin to GND), 1 = Common Anode (longest pin to 3.3V)

// ESP32-S3 GPIO Pin Assignments
#define RGB_R            4      // ESP32-S3 GPIO 4 -> 220 ohm resistor -> Red pin
#define RGB_G            5      // ESP32-S3 GPIO 5 -> 220 ohm resistor -> Green pin
#define RGB_B            6      // ESP32-S3 GPIO 6 -> 220 ohm resistor -> Blue pin

#define LED_PIN          6      // (Only used if USE_NEOPIXEL == 1)
#define NUM_LEDS         16     // (Only used if USE_NEOPIXEL == 1)
#define MAX_BRIGHT       255    // 0-255 scaling factor
#define BAUD             115200 // Native USB CDC baud rate

// ==============================================================================
// 2. WIRELESS (WI-FI) CONFIGURATION (ESP32-S3 ONLY)
// ==============================================================================
// Set ENABLE_WIFI to 1 for standalone wireless operation directly with the Linea server.
// Set to 0 if you are using the USB cable with hardware/bridge.ts (npm start).
#define ENABLE_WIFI      0      // 1 = Direct Wi-Fi SSE client, 0 = USB Serial bridge mode

#if ENABLE_WIFI
#include <WiFi.h>
#include <WiFiClient.h>

const char* WIFI_SSID     = "YOUR_WIFI_SSID";     // Enter your Wi-Fi or Phone Hotspot SSID
const char* WIFI_PASS     = "YOUR_WIFI_PASSWORD"; // Enter your Wi-Fi password
const char* SERVER_HOST   = "192.168.1.100";     // Enter your Laptop IP running Linea server
const int   SERVER_PORT   = 8787;                 // Linea HTTP port
WiFiClient sseClient;
unsigned long lastConnectAttempt = 0;
#endif

// ==============================================================================
// 3. NEOPIXEL CONDITIONAL INCLUDE
// ==============================================================================
#if USE_NEOPIXEL
#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);
#endif

// ==============================================================================
// 4. BEACON MODES & COLOR CONSTANTS
// ==============================================================================
enum Mode { M_IDLE, M_THINK, M_ALERT, M_RING, M_OK, M_OFF };
Mode mode = M_IDLE;
unsigned long modeStart = 0;
String inbuf = "";

void setMode(Mode m) {
  mode = m;
  modeStart = millis();
}

// ==============================================================================
// 5. HUMAN PERCEPTION & BREATHING ANIMATION MATHEMATICS
// ==============================================================================
// Organic physiological respiration curve (Apple breathing sleep LED model)
// f(t) = (exp(sin(t)) - 1/e) / (e - 1/e) -> maps smoothly [0.0, 1.0]
float organicBreathe(unsigned long t, float periodMs) {
  float theta = ((float)(t % (unsigned long)periodMs) / periodMs) * 2.0f * PI;
  float val = exp(sin(theta));
  // Normalize between 0.0 and 1.0: (val - 0.367879) / (2.718282 - 0.367879)
  float norm = (val - 0.367879f) * 0.425459f;
  if (norm < 0.0f) norm = 0.0f;
  if (norm > 1.0f) norm = 1.0f;
  return norm;
}

// Standard sine wave [0.0, 1.0]
float sineWave(unsigned long t, float periodMs) {
  return 0.5f + 0.5f * sin(((float)t / periodMs) * 2.0f * PI);
}

// CIE 1931 / Stevens Gamma 2.2 perceptual scaling table for 8-bit PWM
uint8_t gammaCorrect(float linearFraction) {
  if (linearFraction <= 0.0f) return 0;
  if (linearFraction >= 1.0f) return MAX_BRIGHT;
  // Perceptual exponential response: y = x^2.2
  float corrected = pow(linearFraction, 2.2f);
  return (uint8_t)(corrected * MAX_BRIGHT + 0.5f);
}

// level: 0.0 to 1.0 (overall brightness modulation)
void fillRGB(uint8_t r, uint8_t g, uint8_t b, float level) {
  if (level < 0.0f) level = 0.0f;
  if (level > 1.0f) level = 1.0f;

  float normR = ((float)r / 255.0f) * level;
  float normG = ((float)g / 255.0f) * level;
  float normB = ((float)b / 255.0f) * level;

#if USE_NEOPIXEL
  uint8_t rr = (uint8_t)(normR * 255.0f);
  uint8_t gg = (uint8_t)(normG * 255.0f);
  uint8_t bb = (uint8_t)(normB * 255.0f);
  uint32_t c = strip.gamma32(strip.Color(rr, gg, bb));
  for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, c);
  strip.show();
#else
  uint8_t dutyR = gammaCorrect(normR);
  uint8_t dutyG = gammaCorrect(normG);
  uint8_t dutyB = gammaCorrect(normB);

  #if COMMON_ANODE
    // Invert duty cycle for Common Anode (LOW = ON, HIGH = OFF)
    dutyR = 255 - dutyR;
    dutyG = 255 - dutyG;
    dutyB = 255 - dutyB;
  #endif

  analogWrite(RGB_R, dutyR);
  analogWrite(RGB_G, dutyG);
  analogWrite(RGB_B, dutyB);
#endif
}

void renderThink(unsigned long t) {
#if USE_NEOPIXEL
  float pos = (t % 600) / 600.0f * NUM_LEDS;
  for (int i = 0; i < NUM_LEDS; i++) {
    float d = fabs(i - pos);
    if (d > NUM_LEDS / 2.0f) d = NUM_LEDS - d;
    float l = 1.0f - d / 3.0f;
    if (l < 0.0f) l = 0.0f;
    uint8_t v = (uint8_t)(200 * l);
    strip.setPixelColor(i, strip.gamma32(strip.Color(v, v, v)));
  }
  strip.show();
#else
  // Crisp cool-white/cyan swell and fade pulse (600 ms)
  float swell = sineWave(t, 600.0f);
  fillRGB(220, 245, 255, 0.25f + 0.75f * swell);
#endif
}

void render() {
  unsigned long t = millis() - modeStart;
  switch (mode) {
    case M_IDLE: {
      // Nominal autonomous state: gentle, lifelike physiological breathing green (#30D158)
      // 3.5-second respiration period; minimum floor 10% brightness to remain visibly grounded
      float breath = organicBreathe(t, 3500.0f);
      fillRGB(48, 209, 88, 0.10f + 0.85f * breath);
      break;
    }

    case M_THINK:
      renderThink(t);
      if (t > 700) setMode(M_IDLE);
      break;

    case M_ALERT: {
      // Red watchdog alarm (#FF453A): accelerated 1.5-second deep breathing pulse
      float alertPulse = organicBreathe(t, 1500.0f);
      fillRGB(255, 69, 58, 0.35f + 0.65f * alertPulse);
      break;
    }

    case M_RING: {
      // Phone ringing: 2 Hz urgent double-flash pulse matching telephone ring cadence
      unsigned long subCycle = t % 1000;
      bool ringOn = (subCycle < 200) || (subCycle >= 350 && subCycle < 550);
      fillRGB(255, 30, 30, ringOn ? 1.0f : 0.05f);
      break;
    }

    case M_OK: {
      // 3 crisp emerald green flashes confirming dispatcher resolution
      bool on = ((t / 150) % 2) == 0;
      fillRGB(0, 255, 80, on ? 1.0f : 0.0f);
      if (t > 900) setMode(M_IDLE);
      break;
    }

    case M_OFF:
      fillRGB(0, 0, 0, 0.0f);
      break;
  }
}

// ==============================================================================
// 6. COMMAND HANDLER
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
// 7. WI-FI SSE CLIENT PARSER (ESP32-S3 NATIVE)
// ==============================================================================
#if ENABLE_WIFI
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[WiFi] Connection timeout. Retrying later.");
  }
}

void connectSSE() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (sseClient.connected()) return;
  if (millis() - lastConnectAttempt < 3000) return;
  lastConnectAttempt = millis();

  Serial.println("[SSE] Connecting to Linea server at " + String(SERVER_HOST) + ":" + String(SERVER_PORT));
  if (!sseClient.connect(SERVER_HOST, SERVER_PORT)) {
    Serial.println("[SSE] Connection failed. Retrying...");
    return;
  }

  Serial.println("[SSE] Connected! Requesting GET /events");
  sseClient.print("GET /events HTTP/1.1\r\n");
  sseClient.print("Host: " + String(SERVER_HOST) + ":" + String(SERVER_PORT) + "\r\n");
  sseClient.print("Accept: text/event-stream\r\n");
  sseClient.print("Connection: keep-alive\r\n\r\n");
}

void processSSE() {
  if (!sseClient.connected()) {
    connectSSE();
    return;
  }

  while (sseClient.available()) {
    String line = sseClient.readStringUntil('\n');
    line.trim();
    if (line.startsWith("data:")) {
      String json = line.substring(5);
      json.trim();
      if (json.indexOf("\"type\":\"world.tick\"") >= 0) continue; // Skip 4 Hz position ticks

      // Event classification
      if (json.indexOf("\"type\":\"agent.decision\"") >= 0 || json.indexOf("\"type\":\"agent.thinking\"") >= 0) {
        if (mode == M_IDLE) setMode(M_THINK);
      } else if (json.indexOf("\"type\":\"watchdog.trip\"") >= 0 || json.indexOf("\"type\":\"escalation\"") >= 0) {
        setMode(M_ALERT);
      } else if (json.indexOf("\"type\":\"call.started\"") >= 0 && json.indexOf("\"dispatcher\"") >= 0) {
        setMode(M_RING);
      } else if (json.indexOf("\"type\":\"call.status\"") >= 0) {
        if (mode == M_RING) setMode(M_ALERT);
      } else if (json.indexOf("\"type\":\"call.ended\"") >= 0 || json.indexOf("\"type\":\"watchdog.resolved\"") >= 0) {
        setMode(M_OK);
      }
    }
  }
}
#endif

// ==============================================================================
// 8. SETUP & LOOP
// ==============================================================================
void setup() {
  Serial.begin(BAUD);

#if USE_NEOPIXEL
  strip.begin();
  strip.setBrightness(MAX_BRIGHT);
  strip.clear();
  strip.show();
#else
  pinMode(RGB_R, OUTPUT);
  pinMode(RGB_G, OUTPUT);
  pinMode(RGB_B, OUTPUT);
  fillRGB(0, 0, 0, 0.0f);
#endif

  setMode(M_IDLE);
  Serial.println("LINEA_BEACON_READY");

#if ENABLE_WIFI
  connectWiFi();
#endif
}

void loop() {
  readSerial();

#if ENABLE_WIFI
  if (WiFi.status() == WL_CONNECTED) {
    processSSE();
  } else if (millis() - lastConnectAttempt > 5000) {
    connectWiFi();
  }
#endif

  render();
  delay(16); // ~60 FPS update loop
}
