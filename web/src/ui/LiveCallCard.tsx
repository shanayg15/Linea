import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Phone } from 'lucide-react';
import { useStore, type CallState } from '../data/store';
import { CARGO_LABEL, fmtClock, initials, truckName } from '../data/format';
import { FEED_W, useNow, useSpringT } from './hooks';

const BARS = 28;

export function LiveCallCard() {
  const activeCallId = useStore((s) => s.activeCallId);
  const call = useStore((s) => (s.activeCallId ? s.calls[s.activeCallId] : undefined));
  const callsToday = useStore((s) => s.callsToday);
  const t = useSpringT();
  const active = !!(activeCallId && call);

  return (
    <motion.div
      className="glass absolute overflow-hidden"
      initial={false}
      animate={{ height: active ? 'auto' : 44, borderRadius: active ? 18 : 999 }}
      transition={t}
      style={{ left: 24, bottom: 24, width: FEED_W }}
    >
      <AnimatePresence initial={false}>
        {active ? (
          <motion.div key={activeCallId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} style={{ padding: 20 }}>
            <ActiveCall call={call} />
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 px-4"
            style={{ height: 44 }}
          >
            <Phone size={16} color="var(--label-3)" />
            <span className="t-footnote c-label-2 flex-1">No active calls</span>
            <span className="t-footnote c-label-3 num">
              {callsToday} {callsToday === 1 ? 'call' : 'calls'} today
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ActiveCall({ call }: { call: CallState }) {
  const linea = useStore((s) => s.linea);
  const now = useNow(250);
  const t = useSpringT();
  const { started, ended } = call;
  const truck = started.truckId ? linea?.trucks.find((x) => x.id === started.truckId) : undefined;
  const sub = [started.truckId ? truckName(started.truckId) : 'Dispatcher', truck ? CARGO_LABEL[truck.cargo] : null, started.mode === 'live' ? 'Live phone call' : 'Simulated call']
    .filter(Boolean)
    .join(' · ');
  const elapsed = ((ended ? call.endedAtWall ?? now : now) - call.startedAtWall) / 1000;
  const speaking = now - call.lastSpeechAt < 1500 && !ended;
  const recent = call.utterances.slice(-3);

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="t-body w-semibold c-label flex shrink-0 items-center justify-center rounded-full" style={{ width: 40, height: 40, background: 'var(--elevated-2)' }}>
          {initials(started.personName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="t-headline c-label truncate-1">{started.personName}</div>
          <div className="t-footnote c-label-2 truncate-1">{sub}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!ended && call.status === 'in_progress' && <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--green)' }} />}
          <span className="t-body num c-label">{call.status === 'ringing' && !ended ? 'Ringing' : fmtClock(ended ? ended.durationSec || elapsed : elapsed)}</span>
        </div>
      </div>

      {ended ? (
        <EndedLine call={call} />
      ) : (
        <>
          <Waveform speaking={speaking} speaker={call.lastSpeaker} />
          <div className="t-caption c-label-3 mt-1.5">
            {speaking ? (call.lastSpeaker === 'human' ? `${started.personName} speaking` : 'Linea speaking') : call.status === 'ringing' ? 'Ringing' : 'Listening'}
          </div>
        </>
      )}

      <div className="mt-3 space-y-2">
        <AnimatePresence initial={false}>
          {recent.map((u) => (
            <motion.div key={u.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={t}>
              <div className="t-caption c-label-3">{u.speaker === 'linea' ? 'Linea' : started.personName}</div>
              <div className="t-body c-label mt-0.5 line-clamp-2">{u.text}</div>
              {u.textEnglish && u.textEnglish !== u.text && <div className="t-footnote c-label-2 mt-0.5 line-clamp-2">{u.textEnglish}</div>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {!!call.tools.length && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {call.tools.map((tool, i) => (
            <span key={i} className="t-caption c-label-2 flex items-center gap-1 px-2 py-1" style={{ borderRadius: 999, background: 'rgba(255,255,255,0.08)' }} title={tool.result}>
              {tool.tool}
              <Check size={12} color="var(--green)" strokeWidth={3} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EndedLine({ call }: { call: CallState }) {
  const e = call.ended!;
  const noAnswer = e.outcome === 'no_answer';
  const report = call.tools.some((x) => x.tool === 'report_queue_position');
  const text = noAnswer ? 'No answer' : `Call ended · ${fmtClock(e.durationSec)}${report ? ' · Queue report added' : ''}`;
  return (
    <div className="t-footnote mt-3" style={{ color: noAnswer ? 'var(--orange)' : 'var(--label-2)' }}>
      {text}
    </div>
  );
}

/** 28 bars; random heights every 120 ms while someone spoke < 1.5 s ago, else settle to 4 px. */
function Waveform({ speaking, speaker }: { speaking: boolean; speaker: 'linea' | 'human' | null }) {
  const [heights, setHeights] = useState<number[]>(() => Array(BARS).fill(4));
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  useEffect(() => {
    const id = setInterval(() => {
      setHeights(speakingRef.current ? Array.from({ length: BARS }, (_, i) => 4 + Math.random() * 24 * (0.5 + 0.5 * Math.sin((i / BARS) * Math.PI))) : Array(BARS).fill(4));
    }, 120);
    return () => clearInterval(id);
  }, []);
  const color = speaker === 'human' ? 'rgba(48,209,88,0.85)' : 'rgba(255,255,255,0.85)';
  return (
    <div className="mt-4 flex items-center" style={{ height: 28, gap: 3 }}>
      {heights.map((h, i) => (
        <motion.span key={i} animate={{ height: h }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} style={{ width: 3, borderRadius: 1.5, background: color, display: 'block' }} />
      ))}
    </div>
  );
}
