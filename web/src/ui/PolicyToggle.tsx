import { motion } from 'framer-motion';
import { useStore } from '../data/store';
import { useLayout, useSpringT } from './hooks';

const OPTIONS = [
  { id: 'linea', label: 'With Linea' },
  { id: 'baseline', label: 'Without' },
] as const;

export function PolicyToggle() {
  const policyView = useStore((s) => s.policyView);
  const setPolicyView = useStore((s) => s.setPolicyView);
  const { segLeft } = useLayout();
  const t = useSpringT();
  return (
    <div
      className="absolute flex"
      role="tablist"
      style={{ left: segLeft, top: 28, width: 260, height: 36, padding: 2, borderRadius: 9, background: 'var(--fill-segment)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)' }}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={policyView === o.id}
          onClick={() => setPolicyView(o.id)}
          className="relative flex-1 border-0 bg-transparent p-0 outline-none"
          style={{ fontSize: 13, lineHeight: '18px', fontWeight: 600, color: 'var(--label)', cursor: 'pointer' }}
        >
          {policyView === o.id && (
            <motion.span
              layoutId="seg-thumb"
              transition={t}
              className="absolute inset-0"
              style={{ borderRadius: 7, background: 'var(--thumb)', boxShadow: '0 3px 8px rgba(0,0,0,0.12), 0 3px 1px rgba(0,0,0,0.04)' }}
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
