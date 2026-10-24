// shared/geo.ts — places, border, labels. Coordinates are [lng, lat], approximate.
import type { LngLat } from './types';

export type PlaceKey =
  | 'yard_nueva_tijuana' | 'yard_el_florido' | 'yard_pacifico'
  | 'port_otay_mesa' | 'port_tecate'
  | 'dest_otay_xdock' | 'dest_chula_vista' | 'dest_kearny_mesa' | 'dest_produce';

export const PLACES: Record<PlaceKey, { name: string; pos: LngLat }> = {
  yard_nueva_tijuana: { name: 'Ciudad Industrial Nueva Tijuana', pos: [-116.955, 32.540] },
  yard_el_florido:    { name: 'Parque Industrial El Florido',    pos: [-116.862, 32.497] },
  yard_pacifico:      { name: 'Parque Industrial Pacífico',      pos: [-116.925, 32.524] },
  port_otay_mesa:     { name: 'Otay Mesa (commercial)',          pos: [-116.931, 32.551] },
  port_tecate:        { name: 'Tecate',                          pos: [-116.627, 32.576] },
  dest_otay_xdock:    { name: 'Otay Mesa cross-dock',            pos: [-116.975, 32.565] },
  dest_chula_vista:   { name: 'Chula Vista DC',                  pos: [-117.030, 32.620] },
  dest_kearny_mesa:   { name: 'Kearny Mesa medical DC',          pos: [-117.135, 32.828] },
  dest_produce:       { name: 'San Diego produce terminal',      pos: [-117.130, 32.700] },
};

export const YARDS = ['yard_nueva_tijuana', 'yard_el_florido', 'yard_pacifico'] as const;
export const PORTS = ['port_otay_mesa', 'port_tecate'] as const;
export const DESTS = ['dest_otay_xdock', 'dest_chula_vista', 'dest_kearny_mesa', 'dest_produce'] as const;

// The California–Baja California border is a straight line from the Pacific to the Colorado River.
export const BORDER_LINE: LngLat[] = [[-117.1240, 32.5343], [-114.7194, 32.7184]];

export const MAP_LABELS: { text: string; pos: LngLat }[] = [
  { text: 'Tijuana',   pos: [-117.02, 32.50] },
  { text: 'San Diego', pos: [-117.14, 32.74] },
  { text: 'Otay Mesa', pos: [-116.94, 32.565] },
  { text: 'Tecate',    pos: [-116.63, 32.59] },
];

/** Key into shared/routes.json, e.g. routeKey('yard_el_florido', 'port_otay_mesa'). */
export function routeKey(from: PlaceKey, to: PlaceKey): string {
  return `${from}__${to}`;
}

export interface RouteGeom { coords: LngLat[]; distanceM: number; durationS: number; source?: 'osrm' | 'hand' }
export type RoutesFile = Record<string, RouteGeom>;
