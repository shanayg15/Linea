import type { TruckState } from '@shared/types';

export type RGBA = [number, number, number, number];

export const C = {
  blue: [10, 132, 255] as const,
  orange: [255, 159, 10] as const,
  yellow: [255, 214, 10] as const,
  green: [48, 209, 88] as const,
  gray: [142, 142, 147] as const,
  red: [255, 69, 58] as const,
};

export function rgba(c: readonly [number, number, number], a = 255): RGBA {
  return [c[0], c[1], c[2], a];
}

export function stateColor(s: TruckState): RGBA {
  switch (s) {
    case 'at_yard':
      return rgba(C.gray);
    case 'held':
      return rgba(C.orange);
    case 'en_route':
      return rgba(C.blue);
    case 'in_queue_mx':
    case 'in_queue_us':
      return rgba(C.yellow);
    case 'crossed':
      return rgba(C.green);
    case 'delivered':
      return rgba(C.green, 90);
  }
}
