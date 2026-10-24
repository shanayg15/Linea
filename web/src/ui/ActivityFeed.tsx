import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeftRight, CircleCheck, CirclePause, Phone, Radio, ShieldAlert, Truck, UserRound, Zap, type LucideIcon } from 'lucide-react';
import type { SourceRef } from '@shared/types';
import { useStore, type FeedItem } from '../data/store';
import { fmtClock, fmtMoney, fmtTime, truckName } from '../data/format';
import { FEED_W, useSpringT } from './hooks';

interface RowView {
  icon: LucideIcon;
  accent: string; // CSS var
  title: string;
  sub: string;
  cost?: number;
  pill?: { text: string; tone: 'watchdog' | 'gray' };
  expand?: { reasoning?: string; sources?: SourceRef[]; model?: string; evidence?: string[] };
}

const GOAL_SUB: Record<string, string> = { completed: 'Call ended', no_answer: 'No answer', failed: 'Call failed', handoff: 'Call handed off' };

function view(item: FeedItem): RowView {
  const time = fmtTime(item.simTime);
  switch (item.kind) {
    case 'decision': {
      const e = item.e;
      const fast = e.detail.includes('FAST');
      const icon =
        e.action === 'hold' ? CirclePause : e.action === 'reassign' ? ArrowLeftRight : e.action === 'call_driver' ? Phone : e.action === 'escalate' ? UserRound : fast ? Zap : Truck;
      const accent = e.action === 'hold' || e.action === 'escalate' ? 'var(--orange)' : e.action === 'call_driver' ? 'var(--green)' : 'var(--blue)';
      const pill = e.origin === 'mock' ? { text: 'Optimizer fallback', tone: 'gray' as const } : e.origin === 'chaos' ? { text: 'Chaos test', tone: 'gray' as const } : undefined;
      return {
        icon,
        accent,
        title: e.title,
        sub: `${e.sources[0]?.label ?? e.detail} · ${time}`,
        cost: e.costUsd,
        pill,
        expand: { reasoning: e.reasoning, sources: e.sources, model: e.model },
      };
    }
    case 'blocked': {
      const e = item.e;
      const truck = typeof e.args.truck_id === 'string' ? truckName(e.args.truck_id) : '';
      return {
        icon: ShieldAlert,
        accent: 'var(--orange)',
        title: `Blocked ${e.tool.replace(/_/g, ' ')}${truck ? ` · ${truck}` : ''}`,
        sub: `${e.reason ?? 'Watchdog gate'} · ${time}`,
        pill: { text: 'Watchdog', tone: 'watchdog' },
        expand: { reasoning: e.reason, model: e.origin === 'chaos' ? 'Chaos test' : undefined },
      };
    }
    case 'trip':
      return {
        icon: ShieldAlert,
        accent: 'var(--red)',
        title: item.e.title,
        sub: `${item.e.detail} · ${time}`,
        pill: { text: 'Watchdog', tone: 'watchdog' },
        expand: { evidence: item.e.evidence },
      };
    case 'call': {
      const e = item.e;
      const who = e.truckId ? `${e.personName} · ${truckName(e.truckId)}` : e.personName;
      return {
        icon: Phone,
        accent: e.outcome === 'no_answer' ? 'var(--orange)' : 'var(--green)',
        title: e.outcome === 'no_answer' ? `${e.personName} didn't answer` : `Call with ${who}`,
        sub: `${GOAL_SUB[e.outcome] ?? 'Call ended'} · ${e.mode === 'live' ? 'Live' : 'Simulated'} · ${fmtClock(e.durationSec)} · ${time}`,
        cost: e.costUsd || undefined,
        expand: e.summary ? { reasoning: e.summary } : undefined,
      };
    }
    case 'report':
      return {
        icon: Radio,
        accent: 'var(--yellow)',
        title: `${item.e.reportedBy} reports ~${item.e.lengthKm} km on the Mexican side`,
        sub: `${item.e.source.label} · ${time}`,
        expand: { reasoning: `About ${item.e.extraWaitMin} min of line that CBP doesn't measure.`, sources: [item.e.source] },
      };
    case 'resolved':
      return {
        icon: CircleCheck,
        accent: 'var(--green)',
        title: item.e.resolution,
        sub: `Resolved by ${item.e.by === 'dispatcher' ? 'Ana' : 'Linea'} · ${time}`,
      };
  }
}

export function ActivityFeed() {
  const feed = useStore((s) => s.feed);
  const decisions = useStore((s) => s.metrics?.linea.decisions ?? 0);
  const baseline = useStore((s) => s.policyView === 'baseline');
  return (
    <div className="glass absolute flex flex-col overflow-hidden" style={{ right: 24, top: 24 + 88 + 16, bottom: 24, width: FEED_W }}>
      <div className="flex items-baseline justify-between" style={{ padding: '20px 16px 8px 20px' }}>
        <span className="t-title3 c-label">Activity</span>
        <span className="t-footnote c-label-3 num">{decisions} decisions</span>
      </div>
      <div className="no-scrollbar relative flex-1 overflow-y-auto px-2 pb-2" style={{ opacity: baseline ? 0.4 : 1, transition: 'opacity 300ms' }}>
        <AnimatePresence initial={false}>
          {feed.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </AnimatePresence>
        {!feed.length && <div className="t-footnote c-label-3 px-3 py-6 text-center">Waiting for the first decision</div>}
      </div>
      {baseline && (
        <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ top: '50%' }}>
          <span className="glass t-footnote c-label-2 px-3 py-1.5" style={{ borderRadius: 999 }}>
            The baseline has no agent.
          </span>
        </div>
      )}
    </div>
  );
}

function Row({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const t = useSpringT();
  const v = view(item);
  const Icon = v.icon;
  const hasMore = !!(v.expand && (v.expand.reasoning || v.expand.sources?.length || v.expand.evidence?.length));
  return (
    // New rows grow from zero height so the list below slides down instead of overlapping.
    <motion.div
      initial={{ opacity: 0, y: -8, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={t}
      className="overflow-hidden"
    >
      <div
        onClick={() => hasMore && setOpen((o) => !o)}
        className="flex gap-3 hover:bg-white/[0.04]"
        style={{ minHeight: 64, padding: '12px 16px 12px 12px', borderRadius: 'var(--r-row)', cursor: hasMore ? 'pointer' : 'default' }}
      >
        <div className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 32, height: 32, background: `color-mix(in srgb, ${v.accent} 16%, transparent)` }}>
          <Icon size={16} color={v.accent} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="t-body w-semibold c-label truncate-1 flex-1">{v.title}</span>
            {v.cost !== undefined && v.cost > 0 && <span className="t-footnote c-label-3 num shrink-0">{fmtMoney(v.cost)}</span>}
            {v.pill && (
              <span
                className="t-caption shrink-0 px-2 py-0.5"
                style={{
                  borderRadius: 999,
                  background: v.pill.tone === 'watchdog' ? 'rgba(255,159,10,0.16)' : 'rgba(255,255,255,0.08)',
                  color: v.pill.tone === 'watchdog' ? 'var(--orange)' : 'var(--label-2)',
                }}
              >
                {v.pill.text}
              </span>
            )}
          </div>
          <div className="t-footnote c-label-2 truncate-1 mt-0.5">{v.sub}</div>
          <AnimatePresence initial={false}>
            {open && v.expand && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={t} className="overflow-hidden">
                {v.expand.reasoning && <div className="t-footnote c-label-2 mt-2">{v.expand.reasoning}</div>}
                {!!v.expand.evidence?.length && (
                  <div className="t-footnote c-label-2 mt-2 space-y-0.5">
                    {v.expand.evidence.map((line, i) => (
                      <div key={i} className="num">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
                {!!v.expand.sources?.length && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {v.expand.sources.map((s) => (
                      <span key={s.id} className="t-caption c-label-2 px-2 py-1" style={{ borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
                        {s.label}
                      </span>
                    ))}
                  </div>
                )}
                {v.expand.model && <div className="t-caption c-label-3 mt-2">{v.expand.model}</div>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
