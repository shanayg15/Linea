// Builds shared/routes.json from the public OSRM demo server (run once; runtime never calls OSRM).
// Usage: npx tsx scripts/build-routes.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PLACES, YARDS, PORTS, DESTS, routeKey, type PlaceKey, type RoutesFile, type RouteGeom } from '../shared/geo';
import type { LngLat } from '../shared/types';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'routes.json');

function haversineM(a: LngLat, b: LngLat): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Fallback: 5 straight-ish waypoints with a slight bend, 35 km/h average.
function handRoute(a: LngLat, b: LngLat): RouteGeom {
  const coords: LngLat[] = [];
  for (let i = 0; i <= 5; i++) {
    const f = i / 5;
    const bend = Math.sin(f * Math.PI) * 0.004;
    coords.push([a[0] + (b[0] - a[0]) * f + bend, a[1] + (b[1] - a[1]) * f - bend]);
  }
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversineM(coords[i - 1], coords[i]);
  return { coords, distanceM: Math.round(d * 1.25), durationS: Math.round((d * 1.25) / (35 / 3.6)), source: 'hand' };
}

async function osrm(a: LngLat, b: LngLat): Promise<RouteGeom> {
  const url = `https://router.project-osrm.org/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'linea-hackathon/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { code: string; routes?: { geometry: { coordinates: LngLat[] }; distance: number; duration: number }[] };
    const r = j.routes?.[0];
    if (j.code !== 'Ok' || !r) throw new Error(`OSRM code ${j.code}`);
    const coords = r.geometry.coordinates.map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))] as LngLat);
    return { coords, distanceM: Math.round(r.distance), durationS: Math.round(r.duration), source: 'osrm' };
  } finally {
    clearTimeout(t);
  }
}

const pairs: [PlaceKey, PlaceKey][] = [];
for (const y of YARDS) for (const p of PORTS) pairs.push([y, p]);
for (const p of PORTS) for (const d of DESTS) pairs.push([p, d]);

const routes: RoutesFile = {};
for (const [from, to] of pairs) {
  const a = PLACES[from].pos, b = PLACES[to].pos;
  let g: RouteGeom;
  try {
    g = await osrm(a, b);
  } catch (e) {
    console.warn(`OSRM failed ${from} → ${to}: ${(e as Error).message}; using hand waypoints`);
    g = handRoute(a, b);
  }
  routes[routeKey(from, to)] = g;
  console.log(`${routeKey(from, to).padEnd(40)} ${g.source} ${(g.distanceM / 1000).toFixed(1)} km ${(g.durationS / 60).toFixed(1)} min ${g.coords.length} pts`);
  await new Promise((r) => setTimeout(r, 400));
}
writeFileSync(out, JSON.stringify(routes));
console.log(`wrote ${out}`);
