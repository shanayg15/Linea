# Demo walkthrough

Timed to 2:00 for the video, with both phone calls trimmed to their key lines in editing. Live, let the calls play in full; it runs about 2:30.

The beacon on Ana's desk goes from green to flashing white when the blockage hits, then to red, then Ana's phone rings.

## Setup (10 minutes before)

1. `npx localtunnel --port 8787` and put the URL in `.env` as `PUBLIC_BASE_URL`. Keep that terminal open.
2. `npm start` (Claude mode). The banner must show `agent claude` and the tunnel URL.
3. `npm run web`, then open http://localhost:5173 full screen.
4. Beacon: `cd hardware && npm start`. The light should breathe green.
5. In the dashboard press <kbd>Shift</kbd>+<kbd>R</kbd>, then <kbd>Space</kbd>. At about **2:45 PM** sim time press <kbd>Space</kbd> again to pause. Carlos (Truck 4) is now in the Otay line, and the island says **All clear**.
6. The 925 phone plays Carlos and Ana. Keep it on speaker by the mic and press any key during the Twilio trial message.

With the default `LIVE_DRIVER_CALLS=request`, the only driver call that rings a real phone is the one you trigger with <kbd>C</kbd>, so nothing rings during setup.

## Script

### 0:00 · The problem
**Screen:** map paused at ~2:45 PM, island says "All clear". **Beacon:** breathing green.

> "Nearly a million trucks a year cross north through Otay Mesa, California's busiest commercial port: auto parts, medical supplies, produce. The wait swings from thirty minutes to six hours, and the dispatcher's tools are a government website and texting drivers who are driving. When the line spikes, every truck just joins it. Border delays cost this region three-point-four billion dollars in a single year."

### 0:22 · The solution

> "So we built Linea, an AI dispatcher that runs the whole shift on its own. It reads live border data and decides, truck by truck: go now, take the fast lane, divert to Tecate, or wait at the yard. Drivers only ever hear it on the phone, in Spanish. Live data moving real freight, with no screen for anyone. That's Dispatch."

### 0:45 · All clear
Press <kbd>Space</kbd>. Trucks start moving. **Beacon:** green.

> "Here's a Thursday afternoon. Ten trucks rolling, thirty-five-minute wait. See the light on Ana's desk? Green means Linea has it."

### 0:52 · The blockage
Press <kbd>S</kbd>. The Otay wait jumps to 118 minutes and the queue glow swells. **Beacon:** green to flashing white.

> "Then the line explodes to two hours. Watch it re-plan. It holds the flexible loads at the yard, sends the produce to Tecate, and every move cites the exact record it used."

Point at the new rows in the feed as they land.

### 1:05 · The driver call
Press <kbd>C</kbd>. **Beacon:** still flickering white.

> "But CBP only sees the U.S. side. So it calls Carlos, who's already in line."

- **Linea:** "Hola Carlos, soy Linea, una inteligencia artificial. ¿Ya estás en la fila de Otay?"
- **Carlos:** "Sí, como a dos kilómetros, del lado mexicano."

Linea logs the report, thanks him and hangs up. The clock runs at real time during the call.

> "Two kilometers no feed can see. Carlos just became a sensor, and the plan changed for the other nine trucks."

Point at the dashed segment on the map.

### 1:25 · Red, and the phone rings
Press <kbd>Shift</kbd>+<kbd>O</kbd>. The island springs open red. **Beacon:** red with the chime, and Ana's phone rings.

> "Running for hours alone, the data will go bad. Tecate's feed starts flapping and Linea bounces a truck back and forth. The watchdog blocks the third flip. The light goes red, and it calls Ana."

- **Linea:** "Pedro's truck keeps flipping between Otay and Tecate. Keep him on Otay?"
- **Ana:** "Yes, keep him on Otay."

**Beacon:** three green flashes, then back to breathing green.

### 1:47 · Impact
Press <kbd>L</kbd> to show the trucks piled up without Linea, <kbd>L</kbd> again, then <kbd>F</kbd> for the end card.

> "Without Linea, every truck sits in that line. With it: [truck-hours] truck-hours saved, every load on time, [dollars] of AI for the whole shift. That's Linea."

The end card shows 250,000 truck-hours a year, so you don't need to say it. Fill the bracketed numbers from the card.

## If something fails

| Problem | Do this |
|---|---|
| Phone doesn't ring after <kbd>C</kbd> | Carlos must be in the Otay line (pause after 2:35 PM). Say "it's calling Carlos now" and point at the call card. |
| Ana's call doesn't come | Point at the red island: "it escalates to Ana instead of guessing." |
| Claude or Twilio is down | `npm run mock`: same flow with the rule-based agent and simulated calls. |
| Wi-Fi is down | `MODE=replay RUN_FILE=runs/demo.jsonl npm start` replays a recorded run. |
| Tunnel died | Restart localtunnel, update `PUBLIC_BASE_URL`, restart the server. |

## Video notes

- Record one full live run: a screen capture plus a phone filming the beacon.
- Record the narration separately, reading this script.
- Cut both calls down to the lines shown, and remove the Twilio trial messages.
- At 0:52 and 1:25, cut to the beacon close-up for a beat. Those are the green-to-white and white-to-red moments.
- Fill the bracketed numbers from your best run's end card.
