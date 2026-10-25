// Sim-time helpers. The scenario runs on a fixed -07:00 offset (PDT), so no tz library is needed.
const OFFSET_MS = -7 * 3600_000;

export const MIN = 60_000;

export function ms(iso: string): number {
  return Date.parse(iso);
}

/** "2026-10-22T15:02:00-07:00" → "3:02 PM" */
export function fmtClock(iso: string): string {
  const d = new Date(ms(iso) + OFFSET_MS);
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "6:30 PM" on the sim date of `nowIso` → ISO with -07:00. Returns null if unparseable. */
export function parseClock(text: string, nowIso: string): string | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]?\.?\s*$/.exec(text);
  if (!m) {
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : toIso(t);
  }
  let h = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === 'P') h += 12;
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  const local = new Date(ms(nowIso) + OFFSET_MS);
  const y = local.getUTCFullYear();
  const mo = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00-07:00`;
}

/** Epoch ms → ISO with -07:00. */
export function toIso(t: number): string {
  const d = new Date(t + OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}-07:00`;
}

export function truckLabel(id: string): string {
  return id.replace(/^T/, 'Truck ');
}

export function portLabel(id: string | null | undefined): string {
  return id === 'otay_mesa' ? 'Otay Mesa' : id === 'tecate' ? 'Tecate' : '—';
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
