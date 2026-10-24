// Local copy of TRACK_A_WORLD.md §A2 until shared/geo.ts lands; then switch imports to '@shared/geo'.
export type LngLat = [number, number];

export const PLACES = {
  yard_nueva_tijuana: { name: 'Ciudad Industrial Nueva Tijuana', pos: [-116.955, 32.54] as LngLat },
  yard_el_florido: { name: 'Parque Industrial El Florido', pos: [-116.862, 32.497] as LngLat },
  yard_pacifico: { name: 'Parque Industrial Pacífico', pos: [-116.925, 32.524] as LngLat },
  port_otay_mesa: { name: 'Otay Mesa (commercial)', pos: [-116.931, 32.551] as LngLat },
  port_tecate: { name: 'Tecate', pos: [-116.627, 32.576] as LngLat },
  dest_otay_xdock: { name: 'Otay Mesa cross-dock', pos: [-116.975, 32.565] as LngLat },
  dest_chula_vista: { name: 'Chula Vista DC', pos: [-117.03, 32.62] as LngLat },
  dest_kearny_mesa: { name: 'Kearny Mesa medical DC', pos: [-117.135, 32.828] as LngLat },
  dest_produce: { name: 'San Diego produce terminal', pos: [-117.13, 32.7] as LngLat },
} as const;

export const BORDER_LINE: LngLat[] = [
  [-117.124, 32.5343],
  [-114.7194, 32.7184],
];

export const MAP_LABELS: { text: string; pos: LngLat }[] = [
  { text: 'Tijuana', pos: [-117.02, 32.5] },
  { text: 'San Diego', pos: [-117.14, 32.74] },
  { text: 'Otay Mesa', pos: [-116.94, 32.565] },
  { text: 'Tecate', pos: [-116.63, 32.59] },
];

export const PORT_POS: Record<string, LngLat> = {
  otay_mesa: PLACES.port_otay_mesa.pos,
  tecate: PLACES.port_tecate.pos,
};

// ---- small geometry helpers ----

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPos(a: LngLat, b: LngLat, t: number): LngLat {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

/** Shortest-angle interpolation in degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

function segLen(a: LngLat, b: LngLat): number {
  const kx = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]);
}

/** Sub-path between two fractions of total length. */
export function slicePath(path: LngLat[], from: number, to: number): LngLat[] {
  if (path.length < 2) return path;
  const lens = path.slice(1).map((p, i) => segLen(path[i]!, p));
  const total = lens.reduce((s, l) => s + l, 0);
  const at = (f: number): { i: number; p: LngLat } => {
    let d = f * total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i]! || i === lens.length - 1) return { i, p: lerpPos(path[i]!, path[i + 1]!, lens[i]! ? Math.min(1, d / lens[i]!) : 0) };
      d -= lens[i]!;
    }
    return { i: 0, p: path[0]! };
  };
  const a = at(from);
  const b = at(to);
  return [a.p, ...path.slice(a.i + 1, b.i + 1), b.p];
}
