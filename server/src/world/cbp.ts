// Live CBP Border Wait Times poller (Track A §A8).
// Feeds the UI "LIVE" badge only — the simulator never reads this data.
//
// Source of truth, verified 2026-10-24:
//   JSON  GET https://bwt.cbp.gov/api/bwtnew  → array of port entries (snake_case).
//         Otay Mesa COMMERCIAL = port_number "250602" (crossing_name "Commercial").
//         250601 is Otay Mesa Passenger (commercial lanes N/A); 250608/250609 are
//         other Otay entries with no commercial data. Tecate = "250501" (single
//         entry; commercial has 2 max lanes and FAST is always N/A).
//   HTML  GET https://bwt.cbp.gov/api/bwtrss/rssbyportnum/HTML/ALL/<portNum>
//         RSS item whose description has a "Commercial Vehicles" section with
//         "General Lanes: At 2:00 pm PDT 5 min delay 4 lane(s) open <br/>Fast Lanes: ...".

import type { EventBus } from './api';
import type { PortId, Lane } from '../../../shared/types';

const JSON_URL = 'https://bwt.cbp.gov/api/bwtnew';
const HTML_URL = (portNum: string) => `https://bwt.cbp.gov/api/bwtrss/rssbyportnum/HTML/ALL/${portNum}`;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

interface PortCfg {
  portId: PortId;
  portNum: string;          // commercial crossing
  nameRe: RegExp;
  hasFast: boolean;
}

const PORTS: PortCfg[] = [
  { portId: 'otay_mesa', portNum: '250602', nameRe: /otay\s*mesa/i, hasFast: true },
  { portId: 'tecate', portNum: '250501', nameRe: /tecate/i, hasFast: false },
];
const OTAY_PASSENGER = '250601';
const LANES: Lane[] = ['standard', 'fast'];

interface LaneReading {
  waitMin: number | null;
  lanesOpen: number | null;
  updateTime: string | null;
  ok: boolean;
}
type PortReading = Record<Lane, LaneReading>;

const FAILED: LaneReading = { waitMin: null, lanesOpen: null, updateTime: null, ok: false };

let shapeLogged = false;

// ---------- small helpers ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** First present (non-undefined/null) value among candidate keys, case-insensitive fallback. */
function pick(o: unknown, ...keys: string[]): unknown {
  if (!isObj(o)) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined && o[real] !== undefined && o[real] !== null) return o[real];
  }
  return undefined;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function int(v: unknown): number | null {
  const s = str(v);
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json, application/xml, text/html, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- JSON source ----------

function entriesOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (isObj(data)) {
    for (const k of ['ports', 'data', 'items', 'results', 'port', 'bwt']) {
      const v = pick(data, k);
      if (Array.isArray(v)) return v;
    }
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return null;
}

function commercialOf(entry: unknown): Obj | null {
  const cv = pick(entry, 'commercial_vehicle_lanes', 'commercialVehicleLanes', 'commercialVehicle', 'commercial_vehicle', 'commercial');
  return isObj(cv) ? cv : null;
}

function laneObj(cv: Obj, lane: Lane): unknown {
  return lane === 'standard'
    ? pick(cv, 'standard_lanes', 'standardLanes', 'standard', 'general_lanes', 'generalLanes')
    : pick(cv, 'FAST_lanes', 'fast_lanes', 'fastLanes', 'FASTLanes', 'fast');
}

function hasCommercialData(entry: unknown): boolean {
  const cv = commercialOf(entry);
  if (!cv) return false;
  const max = str(pick(cv, 'maximum_lanes', 'maximumLanes', 'maxLanes'));
  if (max && max.toUpperCase() !== 'N/A') return true;
  const std = laneObj(cv, 'standard');
  const status = str(pick(std, 'operational_status', 'operationalStatus', 'status')).toUpperCase();
  return int(pick(std, 'delay_minutes', 'delayMinutes')) !== null || (status !== '' && status !== 'N/A' && status !== 'UPDATE PENDING');
}

function findEntry(entries: unknown[], cfg: PortCfg): unknown | null {
  const portNum = (e: unknown) => str(pick(e, 'port_number', 'portNumber', 'portNum'));
  const portName = (e: unknown) => str(pick(e, 'port_name', 'portName', 'name'));
  const crossing = (e: unknown) => str(pick(e, 'crossing_name', 'crossingName', 'crossing'));

  const byNum = entries.find((e) => portNum(e) === cfg.portNum);
  if (byNum) return byNum;

  const named = entries.filter((e) => cfg.nameRe.test(portName(e)) && portNum(e) !== OTAY_PASSENGER);
  return (
    named.find((e) => /commercial/i.test(crossing(e)) && commercialOf(e)) ??
    named.find((e) => hasCommercialData(e)) ??
    null
  );
}

function readJsonLane(cv: Obj, lane: Lane): LaneReading {
  const lo = laneObj(cv, lane);
  if (!isObj(lo)) return { ...FAILED };
  const waitMin = int(pick(lo, 'delay_minutes', 'delayMinutes', 'delay'));
  const lanesOpen = int(pick(lo, 'lanes_open', 'lanesOpen'));
  const updateTime = str(pick(lo, 'update_time', 'updateTime')) || null;
  // Feed loaded and the lane object exists: closed / N/A / "Update Pending" → ok with null wait.
  return { waitMin, lanesOpen, updateTime, ok: true };
}

async function pollJson(log: (m: string) => void): Promise<Partial<Record<PortId, PortReading>>> {
  const out: Partial<Record<PortId, PortReading>> = {};
  const text = await fetchText(JSON_URL);
  const data: unknown = JSON.parse(text);
  const entries = entriesOf(data);
  if (!shapeLogged) {
    shapeLogged = true;
    const first = entries?.[0];
    log(
      `[cbp] bwtnew shape: top-level ${Array.isArray(data) ? `array(${(data as unknown[]).length})` : typeof data}` +
        (entries && !Array.isArray(data) ? `, entries array(${entries.length})` : '') +
        `; entry keys: ${isObj(first) ? Object.keys(first).join(',') : typeof first}` +
        `; commercial keys: ${isObj(first) && commercialOf(first) ? Object.keys(commercialOf(first)!).join(',') : 'n/a'}`,
    );
  }
  if (!entries) return out;
  for (const cfg of PORTS) {
    const entry = findEntry(entries, cfg);
    const cv = entry ? commercialOf(entry) : null;
    if (!cv) continue;
    out[cfg.portId] = {
      standard: readJsonLane(cv, 'standard'),
      fast: cfg.hasFast ? readJsonLane(cv, 'fast') : { ...FAILED },
    };
  }
  return out;
}

// ---------- HTML/RSS fallback ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function parseHtmlLane(segment: string | undefined): LaneReading {
  if (segment === undefined) return { ...FAILED };
  const text = segment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const updateTime = text.match(/\bAt\s+\d{1,2}:\d{2}\s*[ap]m(?:\s+[A-Z]{2,4})?/i)?.[0] ?? null;
  const minMatch = text.match(/(\d+)\s*min/i);
  const lanesMatch = text.match(/(\d+)\s*lane\(?s?\)?\s*open/i);
  let waitMin: number | null = minMatch ? Number(minMatch[1]) : null;
  if (waitMin === null && /no delay/i.test(text) && lanesMatch) waitMin = 0;
  // "N/A", "Lanes Closed", "Update Pending" → page loaded, lane closed: ok with nulls.
  return { waitMin, lanesOpen: lanesMatch ? Number(lanesMatch[1]) : null, updateTime, ok: true };
}

async function pollHtml(cfg: PortCfg): Promise<PortReading> {
  const raw = decodeEntities(await fetchText(HTML_URL(cfg.portNum)));
  const cvIdx = raw.search(/Commercial\s+Vehicles/i);
  if (cvIdx < 0) throw new Error('no Commercial Vehicles section');
  let section = raw.slice(cvIdx);
  const end = section.search(/Passenger\s+Vehicles|Pedestrian|<\/description>/i);
  if (end > 0) section = section.slice(0, end);
  const seg = (label: RegExp) => {
    const m = section.match(label);
    return m ? m[1] : undefined;
  };
  const standard = parseHtmlLane(seg(/General\s+Lanes:([\s\S]*?)(?:<br\s*\/?>|Fast\s+Lanes:|$)/i));
  const fast = cfg.hasFast ? parseHtmlLane(seg(/Fast\s+Lanes:([\s\S]*?)(?:<br\s*\/?>|$)/i)) : { ...FAILED };
  if (!standard.ok && !fast.ok) throw new Error('could not parse lane rows');
  return { standard, fast };
}

// ---------- poller ----------

export function startCbpPoller(bus: EventBus, opts?: { intervalMs?: number; log?: (msg: string) => void }): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts?.log ?? ((m: string) => console.log(m));
  let stopped = false;
  let inFlight = false;

  const emitPort = (cfg: PortCfg, reading: PortReading | null) => {
    const fetchedAt = new Date().toISOString();
    for (const lane of LANES) {
      const r = !reading || (lane === 'fast' && !cfg.hasFast) ? FAILED : reading[lane];
      try {
        bus.emit('live.cbp', {
          portId: cfg.portId,
          lane,
          waitMin: r.waitMin,
          lanesOpen: r.lanesOpen,
          updateTime: r.updateTime,
          fetchedAt,
          ok: r.ok,
        });
      } catch (e) {
        log(`[cbp] bus.emit failed: ${errMsg(e)}`);
      }
    }
  };

  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      let fromJson: Partial<Record<PortId, PortReading>> = {};
      try {
        fromJson = await pollJson(log);
      } catch (e) {
        log(`[cbp] JSON feed failed (${errMsg(e)}); falling back to RSS/HTML`);
      }
      for (const cfg of PORTS) {
        if (stopped) return;
        let reading: PortReading | null = fromJson[cfg.portId] ?? null;
        if (!reading) {
          try {
            reading = await pollHtml(cfg);
          } catch (e) {
            log(`[cbp] HTML fallback failed for ${cfg.portId} (${cfg.portNum}): ${errMsg(e)}`);
            reading = null;
          }
        }
        emitPort(cfg, reading);
      }
    } catch (e) {
      log(`[cbp] poll error: ${errMsg(e)}`);
    } finally {
      inFlight = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
