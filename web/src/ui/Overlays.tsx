import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../data/store';
import { FEED_W, useNow } from './hooks';

/** Bottom-center confirmation for hotkey commands (1.2 s). */
export function Toast() {
  const toast = useStore((s) => s.toast);
  const now = useNow(200);
  const visible = toast && now - toast.at < 1200;
  return (
    <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ bottom: 24 + 248 + 16 }}>
      <AnimatePresence>
        {visible && (
          <motion.div
            key={toast.at}
            className="glass t-caption c-label px-3 py-2"
            style={{ borderRadius: 999 }}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Tiny state legend above the call card, only while no call is active. */
export function MapLegend() {
  const active = useStore((s) => !!s.activeCallId);
  if (active) return null;
  const items: [string, string][] = [
    ['En route', 'var(--blue)'],
    ['Held', 'var(--orange)'],
    ['In line', 'var(--yellow)'],
    ['Crossed', 'var(--green)'],
  ];
  return (
    <div className="t-footnote c-label-2 absolute flex gap-4" style={{ left: 24 + 4, bottom: 24 + 44 + 10, width: FEED_W }}>
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** `D`: FPS, last seq, connection state, event counts. */
export function DebugOverlay() {
  const debug = useStore((s) => s.debug);
  const conn = useStore((s) => s.conn);
  const lastSeq = useStore((s) => s.lastSeq);
  const counts = useStore((s) => s.eventCounts);
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  useEffect(() => {
    if (!debug) return;
    let raf = 0;
    const loop = () => {
      frames.current += 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const id = setInterval(() => {
      setFps(frames.current);
      frames.current = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [debug]);
  if (!debug) return null;
  return (
    <div className="glass t-caption c-label-2 num absolute z-40 space-y-1 px-3 py-2" style={{ left: '50%', top: 24 + 88 + 16, transform: 'translateX(-50%)', borderRadius: 12 }}>
      <div>
        {fps} fps · seq {lastSeq} · {conn}
      </div>
      <div className="max-w-md">
        {Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v}`)
          .join(' · ')}
      </div>
    </div>
  );
}
