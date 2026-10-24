import { useEffect, useState } from 'react';
import { useReducedMotion, type Transition } from 'framer-motion';

export const SPRING: Transition = { type: 'spring', stiffness: 300, damping: 30 };
export const INSET = 24;
export const FEED_W = 380;

/** Re-render every `ms` (for timers and "x seconds ago" logic). */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useViewport(): { w: number; h: number } {
  const [s, setS] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setS({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return s;
}

/**
 * Top-row geometry. The segmented control sits centered between the island and the impact strip,
 * and the expanded island is capped so it never runs under the control (matters at 1440 wide).
 */
export function useLayout() {
  const { w, h } = useViewport();
  const compact = w < 1700;
  const stripW = compact ? 660 : 800;
  const stripLeft = w - INSET - stripW;
  const islandRestRight = INSET + 360;
  const segCenter = (islandRestRight + 16 + stripLeft - 16) / 2;
  const segLeft = segCenter - 130;
  const alertW = Math.min(560, segLeft - 16 - INSET);
  const impactW = compact ? 480 : 560;
  return { w, h, compact, stripW, segLeft, alertW, impactW };
}

/** Spring transition, or instant when the user prefers reduced motion. */
export function useSpringT(t: Transition = SPRING): Transition {
  return useReducedMotion() ? { duration: 0 } : t;
}
