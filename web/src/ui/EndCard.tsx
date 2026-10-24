import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../data/store';
import { fmtMoney } from '../data/format';
import { hoursSaved, onTimeCount } from './derived';

export function EndCard() {
  const open = useStore((s) => s.endCard);
  const metrics = useStore((s) => s.metrics);
  const linea = useStore((s) => s.linea);
  const total = metrics?.linea.deliveriesTotal ?? 10;
  const touches = metrics?.linea.humanTouches ?? 0;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center px-12 text-center"
          style={{ background: '#000' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="num c-label" style={{ fontSize: 120, lineHeight: '124px', fontWeight: 600 }}>
            250,000
          </div>
          <div className="c-label-2 mt-4" style={{ fontSize: 24, lineHeight: '30px', fontWeight: 400 }}>
            truck-hours a year at Otay Mesa if every truck saved 15 minutes
          </div>
          <div className="t-footnote c-label-2 num flex flex-wrap justify-center gap-x-8 gap-y-2" style={{ marginTop: 48 }}>
            <span>This shift: {hoursSaved(metrics).toFixed(1)} truck-hours saved on {total} trucks</span>
            <span>
              {onTimeCount(metrics?.linea, linea)}/{total} on time
            </span>
            <span>
              {fmtMoney(metrics?.linea.costUsd ?? 0)} in Claude spend · {touches} human {touches === 1 ? 'touch' : 'touches'}
            </span>
          </div>
          <div className="t-caption c-label-3 absolute inset-x-0 bottom-10 px-12">
            990,111 northbound trucks at Otay Mesa in 2025 (BTS). Border delays cost the region $3.4B and 88,000 jobs (SANDAG, 2016 data).
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
