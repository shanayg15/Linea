import { useStore } from '../data/store';
import { AnimatedNumber } from './AnimatedNumber';
import { hoursSaved, onTimeCount } from './derived';
import { useLayout } from './hooks';

export function ImpactStrip() {
  const metrics = useStore((s) => s.metrics);
  const linea = useStore((s) => s.linea);
  const baseline = useStore((s) => s.baseline);
  const { stripW, compact } = useLayout();

  const saved = hoursSaved(metrics);
  const total = metrics?.linea.deliveriesTotal ?? 10;
  const onTime = onTimeCount(metrics?.linea, linea);
  const onTimeBase = onTimeCount(metrics?.baseline, baseline);
  const spend = metrics?.linea.costUsd ?? 0;
  const touches = metrics?.linea.humanTouches ?? 0;
  const decisions = metrics?.linea.decisions ?? 0;

  return (
    <div className="glass absolute flex" style={{ right: 24, top: 24, width: stripW, height: 88 }}>
      <Stat compact={compact} label="Truck-hours saved">
        <AnimatedNumber value={saved} format={(n) => n.toFixed(1)} className="t-title1 num" style={{ color: saved > 0.5 ? 'var(--green)' : 'var(--label)' }} />
      </Stat>
      <Stat compact={compact} grow={1.3} label="On time" sub={`vs ${onTimeBase} without`}>
        <span className="t-title1 num c-label">
          <AnimatedNumber value={onTime} format={(n) => String(Math.round(n))} />/{total}
        </span>
      </Stat>
      <Stat compact={compact} grow={1.3} label="Claude spend" sub={`$${(spend / total).toFixed(2)} per load`}>
        <AnimatedNumber value={spend} format={(n) => `$${n.toFixed(2)}`} className="t-title1 num c-label" />
      </Stat>
      <Stat compact={compact} label="Human touches" sub={`${decisions} decisions`} last>
        <AnimatedNumber value={touches} format={(n) => String(Math.round(n))} className="t-title1 num c-label" />
      </Stat>
    </div>
  );
}

function Stat({ label, sub, children, last, grow = 1, compact }: { label: string; sub?: string; children: React.ReactNode; last?: boolean; grow?: number; compact?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col justify-center" style={{ flex: `${grow} 1 0`, padding: compact ? '12px 14px' : '12px 20px', borderRight: last ? undefined : '1px solid var(--separator)' }}>
      <div className="t-footnote c-label-2 truncate-1">{label}</div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        {children}
        {sub && !compact && <span className="t-footnote c-label-3 truncate-1">{sub}</span>}
      </div>
    </div>
  );
}
