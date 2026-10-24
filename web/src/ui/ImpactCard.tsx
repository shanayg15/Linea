import { useMemo } from 'react';
import { area, curveMonotoneX, line } from 'd3-shape';
import type { MetricsPoint } from '@shared/types';
import { useStore } from '../data/store';
import { fmtDuration, hourOfDay } from '../data/format';
import { AnimatedNumber } from './AnimatedNumber';
import { hoursSaved, onTimeCount } from './derived';
import { FEED_W, useLayout } from './hooks';

const X0 = 13.5;
const X1 = 19.5;
const TICKS = [14, 15, 16, 17, 18, 19];
const CHART_H = 112;

export function ImpactCard() {
  const metrics = useStore((s) => s.metrics);
  const series = useStore((s) => s.series);
  const clock = useStore((s) => s.clock);
  const linea = useStore((s) => s.linea);
  const baseline = useStore((s) => s.baseline);
  const { impactW } = useLayout();

  const saved = hoursSaved(metrics);
  const total = metrics?.linea.deliveriesTotal ?? 10;
  return (
    <div className="glass absolute" style={{ left: 24 + FEED_W + 16, bottom: 24, width: impactW, height: 248, padding: 20 }}>
      <div className="t-caption c-label-3">Impact so far</div>
      <div className="mt-1 flex items-baseline gap-2">
        <AnimatedNumber value={saved} format={(n) => n.toFixed(1)} className="t-display num c-label" />
        <span className="t-headline w-regular c-label-2">truck-hours out of line</span>
      </div>
      <div className="t-footnote c-label-2 mt-1 flex gap-5 whitespace-nowrap">
        <span>
          Produce in line <span className="c-label num">{fmtDuration(metrics?.linea.produceMinutesInLine ?? 0)}</span> vs{' '}
          <span className="c-label-3 num">{fmtDuration(metrics?.baseline.produceMinutesInLine ?? 0)}</span>
        </span>
        <span>
          On time{' '}
          <span className="c-label num">
            {onTimeCount(metrics?.linea, linea)}/{total}
          </span>{' '}
          vs{' '}
          <span className="c-label-3 num">
            {onTimeCount(metrics?.baseline, baseline)}/{total}
          </span>
        </span>
      </div>
      <Chart series={series} width={impactW - 40} nowHour={clock ? hourOfDay(clock.simTime) : null} />
    </div>
  );
}

function Chart({ series, width, nowHour }: { series: MetricsPoint[]; width: number; nowHour: number | null }) {
  const pts = useMemo(() => series.map((p) => ({ x: hourOfDay(p.t), l: p.linea, b: p.baseline })), [series]);
  const yMax = Math.max(1, ...pts.map((p) => p.b), ...pts.map((p) => p.l)) * 1.1;
  const padTop = 14;
  const padBottom = 16;
  const plotH = CHART_H - padTop - padBottom;
  const sx = (h: number) => ((h - X0) / (X1 - X0)) * width;
  const sy = (v: number) => padTop + plotH - (v / yMax) * plotH;

  const mk = (key: 'l' | 'b') =>
    line<(typeof pts)[number]>()
      .x((p) => sx(p.x))
      .y((p) => sy(p[key]))
      .curve(curveMonotoneX)(pts) ?? '';
  const gap = area<(typeof pts)[number]>()
    .x((p) => sx(p.x))
    .y0((p) => sy(p.l))
    .y1((p) => sy(p.b))
    .curve(curveMonotoneX)(pts) ?? '';

  const best = pts.reduce<(typeof pts)[number] | null>((m, p) => (!m || p.b - p.l > m.b - m.l ? p : m), null);
  const showSaved = best && best.b - best.l > yMax * 0.12;
  const last = pts.at(-1);

  return (
    <div className="relative mt-1">
      <div className="t-caption c-label-2 absolute right-0 flex gap-3" style={{ top: -2 }}>
        <span className="flex items-center gap-1">
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--blue)' }} /> With Linea
        </span>
        <span className="flex items-center gap-1">
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--gray)' }} /> Without
        </span>
      </div>
      <svg width={width} height={CHART_H} style={{ overflow: 'visible', display: 'block' }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={width} y1={padTop + plotH * f} y2={padTop + plotH * f} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        ))}
        <text x={0} y={padTop - 4} className="t-caption" fill="var(--label-3)">
          {Math.round(yMax)} h
        </text>
        {pts.length > 1 && (
          <>
            <path d={gap} fill="var(--green)" fillOpacity={0.12} />
            <path d={mk('b')} fill="none" stroke="rgba(255,255,255,0.30)" strokeWidth={2} />
            <path d={mk('l')} fill="none" stroke="var(--blue)" strokeWidth={2.5} strokeLinecap="round" />
          </>
        )}
        {showSaved && best && (
          <text x={sx(best.x)} y={(sy(best.l) + sy(best.b)) / 2 + 4} textAnchor="middle" className="t-caption" fill="var(--green)">
            Saved
          </text>
        )}
        {nowHour !== null && nowHour >= X0 && nowHour <= X1 && <line x1={sx(nowHour)} x2={sx(nowHour)} y1={padTop} y2={padTop + plotH} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />}
        {last && <circle cx={sx(last.x)} cy={sy(last.l)} r={3} fill="var(--blue)" />}
        {TICKS.map((h) => (
          <text key={h} x={sx(h)} y={CHART_H} textAnchor="middle" className="t-caption" fill="var(--label-3)">
            {h - 12} PM
          </text>
        ))}
      </svg>
    </div>
  );
}
