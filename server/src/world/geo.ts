// Path helpers. All coordinates are [lng, lat].
import type { LngLat } from '../../../shared/types';

const R_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing a → b in degrees, 0 = north, clockwise. */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const cumCache = new WeakMap<LngLat[], number[]>();
function cumulative(path: LngLat[]): number[] {
  let c = cumCache.get(path);
  if (!c) {
    c = [0];
    for (let i = 1; i < path.length; i++) c.push(c[i - 1] + haversineKm(path[i - 1], path[i]));
    cumCache.set(path, c);
  }
  return c;
}

export function lengthKm(path: LngLat[]): number {
  if (path.length < 2) return 0;
  const c = cumulative(path);
  return c[c.length - 1];
}

/** Point at a fraction (0..1) of the path's length, with heading of the segment it lies on. */
export function pointAlong(path: LngLat[], fraction: number): { pos: LngLat; heading: number } {
  if (path.length === 0) return { pos: [0, 0], heading: 0 };
  if (path.length === 1) return { pos: path[0], heading: 0 };
  const c = cumulative(path);
  const total = c[c.length - 1];
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= target) lo = mid; else hi = mid;
  }
  const seg = c[hi] - c[lo];
  const f = seg > 0 ? (target - c[lo]) / seg : 0;
  const a = path[lo], b = path[hi];
  return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
}

/** Sub-path between two fractions of the path's length. */
export function slicePath(path: LngLat[], fromFrac: number, toFrac: number): LngLat[] {
  if (path.length < 2) return path.slice();
  const c = cumulative(path);
  const total = c[c.length - 1];
  const a = Math.max(0, Math.min(1, fromFrac)) * total;
  const b = Math.max(0, Math.min(1, toFrac)) * total;
  const out: LngLat[] = [pointAlong(path, fromFrac).pos];
  for (let i = 0; i < path.length; i++) if (c[i] > a && c[i] < b) out.push(path[i]);
  out.push(pointAlong(path, toFrac).pos);
  return out;
}

/** The last `km` of a path. */
export function lastKm(path: LngLat[], km: number): LngLat[] {
  const total = lengthKm(path);
  if (total <= km) return path.slice();
  return slicePath(path, 1 - km / total, 1);
}

/** Index of the path vertex nearest to `p`. */
export function nearestIndex(path: LngLat[], p: LngLat): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = haversineKm(path[i], p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Reduce vertex count (keeps first/last) — for payload size. */
export function downsample(path: LngLat[], maxPts: number): LngLat[] {
  if (path.length <= maxPts) return path.slice();
  const out: LngLat[] = [];
  for (let i = 0; i < maxPts; i++) out.push(path[Math.round((i * (path.length - 1)) / (maxPts - 1))]);
  return out;
}

export function roundPos(p: LngLat): LngLat {
  return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
}
