// Sim time is Pacific (-07:00 on the replay day); format without depending on the viewer's timezone.
const OFFSET_MS = -7 * 3600_000;

function local(iso: string): Date {
  return new Date(Date.parse(iso) + OFFSET_MS);
}

/** "3:02 PM" */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = local(iso);
  const h = d.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Thu" */
export function fmtWeekday(iso: string | null | undefined): string {
  if (!iso) return '';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local(iso).getUTCDay()]!;
}

/** Hours of the day as a float (13.5 = 1:30 PM), in sim-local time. */
export function hourOfDay(iso: string): number {
  const d = local(iso);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** "22 min" / "2 h 41 min" */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function fmtMoney(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** "0:42" */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const CARGO_LABEL: Record<string, string> = {
  auto_parts: 'Auto parts',
  medical: 'Medical',
  produce: 'Produce',
  general: 'General',
};

export function truckName(id: string | null | undefined): string {
  return id ? `Truck ${id.replace(/^T/, '')}` : '';
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
