import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ShieldAlert } from 'lucide-react';
import type { TripKind, WatchdogState, WatchdogStatus } from '@shared/types';
import { useStore } from '../data/store';
import { fmtMoney, fmtTime, fmtWeekday } from '../data/format';
import { useLayout, useNow, useSpringT } from './hooks';

const TRIP_TITLE: Record<TripKind, string> = {
  oscillation: 'Loop detected',
  no_answer: 'Driver not answering',
  budget: 'Budget guard',
  no_progress: 'No progress — paused',
  repeat_call: 'Repeat call blocked',
  repeat_tool: 'Repeated action blocked',
  uncited: 'Uncited action blocked',
  not_worth_it: 'Call not worth it',
};

const DOT: Record<WatchdogState, string> = { ok: 'var(--green)', warn: 'var(--orange)', tripped: 'var(--red)' };
const ISLAND_SPRING = { type: 'spring', stiffness: 400, damping: 32 } as const;

export function StatusIsland() {
  const clock = useStore((s) => s.clock);
  const policyView = useStore((s) => s.policyView);
  const lastThinkingAt = useStore((s) => s.lastThinkingAt);
  const activeTrip = useStore((s) => s.activeTrip);
  const resolvedFlash = useStore((s) => s.resolvedFlash);
  const watchdog = useStore((s) => s.watchdog);
  const live = useStore((s) => s.live);
  const { alertW } = useLayout();
  const now = useNow(150);
  const t = useSpringT(ISLAND_SPRING);

  const thinking = now - lastThinkingAt < 1200 && lastThinkingAt > 0;
  const resolved = resolvedFlash && now - resolvedFlash.at < 1500 && !activeTrip;
  const mode: 'alert' | 'resolved' | 'rest' = activeTrip ? 'alert' : resolved ? 'resolved' : 'rest';
  const width = mode === 'alert' ? alertW : mode === 'resolved' ? 360 : thinking ? 360 : 320;
  const height = mode === 'alert' ? 104 : 44;

  return (
    <div className="absolute flex flex-col items-start gap-2" style={{ left: 24, top: 24 }}>
      <motion.div
        className="relative overflow-hidden"
        initial={false}
        animate={{
          width,
          height,
          borderRadius: mode === 'alert' ? 28 : 999,
          borderColor: mode === 'alert' ? 'rgba(255,69,58,0.5)' : mode === 'resolved' ? 'rgba(48,209,88,0.6)' : 'rgba(255,255,255,0.08)',
        }}
        transition={t}
        style={{
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'var(--glass-blur)',
          WebkitBackdropFilter: 'var(--glass-blur)',
          borderWidth: 1,
          borderStyle: 'solid',
          boxShadow: 'var(--glass-shadow)',
        }}
      >
        <motion.div
          className="pointer-events-none absolute inset-0"
          initial={false}
          animate={{ opacity: mode === 'alert' ? 1 : 0 }}
          transition={t}
          style={{ background: 'rgba(255,69,58,0.16)' }}
        />
        <AnimatePresence initial={false}>
          {mode === 'alert' && activeTrip ? (
            <motion.div
              key={`alert-${activeTrip.tripId}`}
              className="absolute inset-0 flex items-start justify-between gap-3 px-5 py-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <ShieldAlert size={18} color="var(--red)" strokeWidth={2.2} />
                  <span className="t-headline c-label truncate-1">{TRIP_TITLE[activeTrip.kind]}</span>
                </div>
                <div className="t-footnote c-label-2 mt-2 truncate-1">{activeTrip.detail || activeTrip.title}</div>
              </div>
              <span className="t-caption c-label-2 shrink-0 px-2 py-1" style={{ borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
                Watchdog
              </span>
            </motion.div>
          ) : mode === 'resolved' ? (
            <motion.div
              key="resolved"
              className="absolute inset-0 flex items-center gap-2 px-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <span className="t-headline c-label">Resolved by Ana</span>
            </motion.div>
          ) : (
            <motion.div
              key="rest"
              className="absolute inset-0 flex items-center justify-between px-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                <span className="t-headline c-label">Linea</span>
                <span className="c-label-3">·</span>
                {policyView === 'baseline' ? (
                  <span className="t-footnote c-label-2">Without Linea · simulated</span>
                ) : thinking ? (
                  <span className="t-footnote c-label-2 flex items-center gap-1.5">
                    Re-planning
                    <span className="flex gap-0.5">
                      {[0, 1, 2].map((i) => (
                        <span key={i} className="shimmer-dot inline-block h-1 w-1 rounded-full bg-white" style={{ animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </span>
                  </span>
                ) : (
                  <>
                    <span className="t-footnote c-label-2 num">{clock ? `${fmtWeekday(clock.simTime)} ${fmtTime(clock.simTime)}` : 'Connecting'}</span>
                    {clock && <span className="t-caption c-label-3 num">{clock.paused ? 'Paused' : `${clock.speed}×`}</span>}
                    {clock && allClear(watchdog) && (
                      <span className="t-caption num" style={{ color: 'var(--green)' }}>
                        All clear
                      </span>
                    )}
                  </>
                )}
              </div>
              <WatchdogDots status={watchdog} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <LiveCbpPill live={live} />
    </div>
  );
}

function WatchdogDots({ status }: { status: WatchdogStatus | null }) {
  const [hover, setHover] = useState(false);
  const debug = useStore((s) => s.debug);
  const states: WatchdogState[] = status ? [status.budget.state, status.loops.state, status.progress.state] : ['ok', 'ok', 'ok'];
  return (
    <div className="relative flex shrink-0 items-center gap-1.5 pl-3" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {states.map((s, i) => (
        <span key={i} className="inline-block rounded-full" style={{ width: 6, height: 6, background: DOT[s] }} />
      ))}
      {(hover || debug) && status && (
        <div className="glass t-caption c-label-2 absolute left-1/2 top-7 z-10 -translate-x-1/2 whitespace-nowrap px-3 py-2" style={{ borderRadius: 12 }}>
          <div>
            Budget {fmtMoney(status.budget.usedUsd)} of {fmtMoney(status.budget.capUsd)} · {status.budget.model}
          </div>
          <div className="mt-1">Loops · {status.loops.detail}</div>
          <div className="mt-1">
            Progress · {status.progress.fleetDelayMin} min projected delay · {status.progress.trend}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtUpdate(u: string | null): string {
  if (!u) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(u);
  if (m && !u.includes('T')) {
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const ms = Date.parse(u);
  return Number.isNaN(ms) ? u : fmtTime(u);
}

function LiveCbpPill({ live }: { live: Record<string, import('@shared/types').PayloadOf<'live.cbp'>> }) {
  const otay = live['otay_mesa:standard'] ?? Object.values(live)[0];
  if (!otay) return null;
  const open = otay.ok && otay.waitMin != null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass t-footnote c-label-2 flex items-center gap-2 whitespace-nowrap px-3"
      style={{ height: 28, borderRadius: 999 }}
    >
      <span className={open ? 'pulse-dot' : ''} style={{ width: 6, height: 6, borderRadius: 999, background: open ? 'var(--green)' : 'var(--gray)' }} />
      {open ? (
        <span>
          Live · CBP Otay Mesa commercial · <span className="num">{otay.waitMin} min</span>
          {otay.updateTime ? ` · updated ${fmtUpdate(otay.updateTime)}` : ''}
        </span>
      ) : (
        <span>CBP commercial lanes closed today</span>
      )}
    </motion.div>
  );
}

/** Nothing needs Ana: every watchdog check is ok (or no status yet). */
function allClear(status: WatchdogStatus | null | undefined): boolean {
  if (!status) return true;
  return status.budget.state === 'ok' && status.loops.state === 'ok' && status.progress.state === 'ok';
}
