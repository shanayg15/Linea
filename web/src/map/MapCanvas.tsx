import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import type { PortStatus, Truck, WorldView } from '@shared/types';
import { useStore } from '../data/store';
import { BORDER_LINE, MAP_LABELS, PORT_POS, lerpAngle, lerpPos, slicePath, type LngLat } from '../geo';
import { fmtTime } from '../data/format';
import { C, rgba, stateColor, type RGBA } from './colors';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
// Spec center is [-116.93, 32.63]; shifted east so Tecate isn't hidden under the activity feed.
const VIEW = { center: [-116.84, 32.63] as LngLat, zoom: 10.3, pitch: 35, bearing: -12 };
const TRAIL_POINTS = 40;
const TRAIL_SAMPLE_MS = 250;
const MX_FRACTION = 0.7;
const dashed = new PathStyleExtension({ dash: true });

interface InterpTruck {
  t: Truck;
  pos: LngLat;
  heading: number;
}

/** Lerp truck positions between the last two ticks (ticks arrive at ~4 Hz). */
function interpolate(cur: WorldView, prev: WorldView | null, alpha: number): InterpTruck[] {
  const byId = new Map(prev?.trucks.map((t) => [t.id, t]) ?? []);
  return cur.trucks.map((t) => {
    const p = byId.get(t.id);
    if (!p) return { t, pos: t.pos, heading: t.heading };
    return { t, pos: lerpPos(p.pos, t.pos, alpha), heading: lerpAngle(p.heading, t.heading, alpha) };
  });
}

function patchStyle(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id;
    try {
      if (layer.type === 'background') map.setPaintProperty(id, 'background-color', '#0B0C0E');
      else if (id.includes('water') && layer.type === 'fill') map.setPaintProperty(id, 'fill-color', '#0A0D12');
      else if (id.includes('road') && layer.type === 'line') {
        const major = /major|motorway|trunk|primary|highway/.test(id);
        map.setPaintProperty(id, 'line-color', major ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)');
      } else if (layer.type === 'symbol') map.setLayoutProperty(id, 'visibility', 'none');
    } catch {
      // some layers use paint properties we can't override; skip them
    }
  }
}

export function MapCanvas() {
  const container = useRef<HTMLDivElement>(null);
  const callout = useRef<HTMLDivElement>(null);
  const calloutText = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const map = new maplibregl.Map({
      container: el,
      style: STYLE,
      center: VIEW.center,
      zoom: 9.6,
      pitch: VIEW.pitch,
      bearing: VIEW.bearing,
      attributionControl: false,
      interactive: true,
    });
    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);
    map.on('style.load', () => patchStyle(map));
    map.once('load', () => {
      map.flyTo({ ...VIEW, duration: 1600, essential: true });
    });

    const trails = new Map<string, { path: LngLat[]; ts: number[] }>();
    let lastTrailAt = 0;
    const colors = new Map<string, ColorFade>();
    let lastPolicy: string | null = null;
    let switchedAt = 0;
    let raf = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const s = useStore.getState();
      const now = performance.now();
      const view = s.policyView === 'baseline' ? s.baseline : s.linea;
      if (!view) return;
      const prev = s.prevTick ? (s.policyView === 'baseline' ? s.prevTick.baseline : s.prevTick.linea) : null;
      const interval = s.prevTick ? Math.max(100, s.lastTickAt - s.prevTick.at) : 250;
      const alpha = Math.min(1, Math.max(0, (now - s.lastTickAt) / interval));
      const trucks = interpolate(view, prev, alpha);

      if (lastPolicy !== s.policyView) {
        lastPolicy = s.policyView;
        switchedAt = now;
        trails.clear();
      }
      const fade = Math.min(1, (now - switchedAt) / 300);

      // 400 ms state-color fade. Done by hand: deck's attribute transitions restart every frame
      // because the data array is rebuilt each frame for interpolation.
      for (const it of trucks) {
        const target = stateColor(it.t.state);
        const c = colors.get(it.t.id);
        if (!c) colors.set(it.t.id, { from: target, to: target, start: now });
        else if (c.to.join() !== target.join()) colors.set(it.t.id, { from: mixColor(c, now), to: target, start: now });
      }

      if (now - lastTrailAt >= TRAIL_SAMPLE_MS) {
        lastTrailAt = now;
        for (const it of trucks) {
          const tr = trails.get(it.t.id) ?? { path: [], ts: [] };
          tr.path.push(it.pos);
          tr.ts.push(now);
          if (tr.path.length > TRAIL_POINTS) {
            tr.path.shift();
            tr.ts.shift();
          }
          trails.set(it.t.id, tr);
        }
      }

      const ports: PortStatus[] = view.ports;
      const activeCall = s.activeCallId ? s.calls[s.activeCallId] : null;
      const callTruck = activeCall && !activeCall.ended ? trucks.find((x) => x.t.id === activeCall.started.truckId) : undefined;
      const trip = s.activeTrip;
      const tripElapsed = trip ? now - tripSeenAt(trip.tripId, now) : 0;

      const layers: Layer[] = [
        new PathLayer({
          id: 'border',
          data: [{ path: BORDER_LINE }],
          getPath: (d: { path: LngLat[] }) => d.path,
          getColor: [255, 255, 255, 77],
          widthUnits: 'pixels',
          getWidth: 1,
          widthMinPixels: 1,
          getDashArray: [6, 4],
          dashJustified: true,
          extensions: [dashed],
        } as never),
        new PathLayer({
          id: 'routes',
          data: trucks.filter((x) => x.t.port && x.t.state !== 'delivered' && x.t.state !== 'at_yard'),
          getPath: (x: InterpTruck) => {
            const port = PORT_POS[x.t.port!]!;
            return x.t.state === 'crossed' ? [x.pos, x.t.destination.pos] : [x.pos, port, x.t.destination.pos];
          },
          getColor: [255, 255, 255, 20],
          widthUnits: 'pixels',
          getWidth: 2,
          capRounded: true,
          jointRounded: true,
        }),
        new PathLayer({
          id: 'queue-us',
          data: ports.filter((p) => p.standard.waitMin != null && p.queuePath.length > 1),
          getPath: (p: PortStatus) => slicePath(p.queuePath as LngLat[], MX_FRACTION, 1),
          getColor: (p: PortStatus) => rgba(C.yellow, 80 + 150 * Math.min(1, (p.standard.waitMin ?? 0) / 120)),
          widthUnits: 'pixels',
          getWidth: 6,
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getColor: ports.map((p) => p.standard.waitMin).join(',') },
        }),
        new PathLayer({
          id: 'queue-mx',
          data: ports.filter((p) => p.mxSideExtraMin > 0 && p.queuePath.length > 1),
          getPath: (p: PortStatus) => slicePath(p.queuePath as LngLat[], 0, MX_FRACTION),
          getColor: (p: PortStatus) => rgba(C.yellow, 80 + 150 * Math.min(1, p.mxSideExtraMin / 120)),
          widthUnits: 'pixels',
          getWidth: 6,
          capRounded: true,
          getDashArray: [2, 1.5],
          dashJustified: true,
          extensions: [dashed],
        } as never),
        new ScatterplotLayer({
          id: 'queue-pulse',
          data: ports.filter((p) => p.standard.waitMin != null),
          getPosition: (p: PortStatus) => p.pos,
          radiusUnits: 'pixels',
          getRadius: (p: PortStatus) => 8 + (p.standard.waitMin ?? 0) / 6,
          getFillColor: rgba(C.yellow, Math.round(40 + 25 * Math.sin((now / 1600) * 2 * Math.PI))),
          stroked: false,
          updateTriggers: { getFillColor: Math.round(now / 50), getRadius: ports.map((p) => p.standard.waitMin).join(',') },
        }),
        new TripsLayer({
          id: 'trails',
          data: [...trails.entries()].map(([id, tr]) => ({ id, path: tr.path, ts: tr.ts, color: stateColor(trucks.find((x) => x.t.id === id)?.t.state ?? 'at_yard') })),
          getPath: (d: { path: LngLat[] }) => d.path,
          getTimestamps: (d: { ts: number[] }) => d.ts,
          getColor: (d: { color: RGBA }) => [d.color[0], d.color[1], d.color[2]],
          currentTime: now,
          trailLength: 8000,
          fadeTrail: true,
          widthMinPixels: 3,
          capRounded: true,
          jointRounded: true,
          opacity: fade,
        }),
        new ScatterplotLayer({
          id: 'trucks',
          data: trucks,
          getPosition: (x: InterpTruck) => x.pos,
          radiusUnits: 'pixels',
          getRadius: 6,
          radiusMinPixels: 6,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          lineWidthMinPixels: 2,
          getLineColor: [0, 0, 0, 255],
          getFillColor: (x: InterpTruck) => {
            const c = colors.get(x.t.id);
            return c ? mixColor(c, now) : stateColor(x.t.state);
          },
          opacity: fade,
        }),
        new ScatterplotLayer({
          id: 'call-ring',
          data: callTruck ? [callTruck] : [],
          getPosition: (x: InterpTruck) => x.pos,
          radiusUnits: 'pixels',
          getRadius: 14 + 2 * Math.sin((now / 800) * 2 * Math.PI),
          filled: false,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          getLineColor: [255, 255, 255, 200],
          updateTriggers: { getRadius: Math.round(now / 50) },
        }),
        new PathLayer({
          id: 'osc-flash',
          data: oscillationPaths(trip, trucks, tripElapsed),
          getPath: (d: LngLat[]) => d,
          getColor: rgba(C.red, 230),
          widthUnits: 'pixels',
          getWidth: 4,
          capRounded: true,
          jointRounded: true,
        }),
        new TextLayer({
          id: 'labels',
          data: MAP_LABELS.map((l) => ({ ...l, text: portLabel(l.text, ports) })),
          getPosition: (d: { pos: LngLat }) => d.pos,
          getText: (d: { text: string }) => d.text,
          getSize: 13,
          getColor: [235, 235, 245, 153],
          fontFamily: '-apple-system, BlinkMacSystemFont, Inter, sans-serif',
          fontWeight: 600,
          characterSet: 'auto',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: [0, -10],
          updateTriggers: { getText: ports.map((p) => p.standard.waitMin).join(',') },
        }),
      ];
      overlay.setProps({ layers });

      // Driver-report callout at the start of the dashed MX segment (Linea view only)
      const box = callout.current;
      if (box) {
        const otay = ports.find((p) => p.mxSideExtraMin > 0);
        const report = otay ? [...s.queueReports].reverse().find((r) => r.portId === otay.id) : undefined;
        if (s.policyView === 'linea' && otay && report && otay.queuePath[0]) {
          const pt = map.project(otay.queuePath[0] as LngLat);
          box.style.transform = `translate(${Math.round(pt.x)}px, ${Math.round(pt.y)}px) translate(-50%, calc(-100% - 12px))`;
          if (calloutText.current) calloutText.current.textContent = `~${report.lengthKm} km · reported by ${report.reportedBy} · ${fmtTime(report.source.observedAt)}`;
          if (box.dataset.shown !== '1') {
            box.dataset.shown = '1';
            box.animate([{ opacity: 0, scale: '0.9' }, { opacity: 1, scale: '1' }], { duration: 380, easing: 'cubic-bezier(.2,1.4,.4,1)', fill: 'forwards' });
          }
        } else if (box.dataset.shown === '1') {
          box.dataset.shown = '0';
          box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      map.remove();
    };
  }, []);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-0 top-0" style={{ opacity: 0 }} ref={callout} data-shown="0">
        <div className="glass t-caption c-label whitespace-nowrap px-3 py-1.5" style={{ borderRadius: 'var(--r-pill)' }}>
          <span ref={calloutText} />
        </div>
      </div>
    </div>
  );
}

interface ColorFade {
  from: RGBA;
  to: RGBA;
  start: number;
}
function mixColor(c: ColorFade, now: number): RGBA {
  const k = Math.min(1, (now - c.start) / 400);
  return c.from.map((v, i) => Math.round(v + (c.to[i]! - v) * k)) as RGBA;
}

// Trip first-seen times (wall), for the 3 s oscillation flash.
const tripSeen = new Map<string, number>();
function tripSeenAt(tripId: string, now: number): number {
  if (!tripSeen.has(tripId)) tripSeen.set(tripId, now);
  return tripSeen.get(tripId)!;
}

/** Red Otay↔Tecate flip path for the tripped truck, flashing twice over 3 s. */
function oscillationPaths(trip: ReturnType<typeof useStore.getState>['activeTrip'], trucks: InterpTruck[], elapsed: number): LngLat[][] {
  if (!trip || trip.kind !== 'oscillation' || !trip.truckId || elapsed > 3000) return [];
  if (Math.floor(elapsed / 750) % 2 === 1) return [];
  const t = trucks.find((x) => x.t.id === trip.truckId);
  if (!t) return [];
  return [
    [t.pos, PORT_POS.otay_mesa!],
    [t.pos, PORT_POS.tecate!],
  ];
}

function portLabel(text: string, ports: PortStatus[]): string {
  const id = text === 'Otay Mesa' ? 'otay_mesa' : text === 'Tecate' ? 'tecate' : null;
  const p = id ? ports.find((x) => x.id === id) : undefined;
  return p && p.standard.waitMin != null ? `${text} · ${p.standard.waitMin} min` : text;
}
