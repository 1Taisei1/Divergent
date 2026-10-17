import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { pad3 } from './drones';
import './timeline.css';

export type TimelineEvent = { t: number; kind: string };

type Props = {
  t: number;
  max: number;
  playing: boolean;
  onT: (t: number) => void;
  onPlay: (playing: boolean) => void;
  marks?: number[];
  events?: TimelineEvent[];
};

// Alert kinds fold into four colour groups, stacked bottom to top in this order.
type Group = 'risk' | 'origin' | 'site' | 'track';
const GROUPS: { id: Group; label: string }[] = [
  { id: 'risk', label: 'Risk' },
  { id: 'origin', label: 'Origin' },
  { id: 'site', label: 'Site' },
  { id: 'track', label: 'Track' },
];
const KIND_GROUP: Record<string, Group> = {
  route_exposed: 'risk',
  recon_auto_return: 'risk',
  mark: 'risk', // a bare alert time from `marks`, which carries no kind
  origin_confident: 'origin',
  launch_team_moved: 'origin',
  launch_forecast: 'origin',
  launch_site_confirmed: 'site',
  new_track: 'track',
  track_lost: 'track',
};
const groupOf = (kind: string): Group => KIND_GROUP[kind] ?? 'track';

type Slot = { total: number; groups: Record<Group, number>; kinds: Record<string, number> };

const emptySlot = (): Slot => ({ total: 0, groups: { risk: 0, origin: 0, site: 0, track: 0 }, kinds: {} });

// One slot per simulated second (0..max), a cumulative alert count per slot, and the tallest stack.
function bucket(events: TimelineEvent[], max: number) {
  const n = Math.max(1, max + 1);
  const slots = Array.from({ length: n }, emptySlot);
  for (const e of events) {
    const s = slots[Math.min(n - 1, Math.max(0, Math.round(e.t)))];
    s.total += 1;
    s.groups[groupOf(e.kind)] += 1;
    s.kinds[e.kind] = (s.kinds[e.kind] ?? 0) + 1;
  }
  let peak = 1;
  let run = 0;
  const cum = slots.map((s) => {
    peak = Math.max(peak, s.total);
    run += s.total;
    return run;
  });
  return { slots, cum, peak, total: run };
}

const STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300];
const tickStep = (max: number) => STEPS.find((s) => max / s <= 12) ?? 600;
const pad2 = (n: number) => String(n).padStart(2, '0');
const kindLabel = (k: string) => k.replace(/_/g, ' ');

const Histogram = memo(function Histogram({ slots, peak, ticks }: { slots: Slot[]; peak: number; ticks: number[] }) {
  const n = slots.length;
  const style = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, '--m': peak } as CSSProperties;
  return (
    <div className="tl-plot" aria-hidden="true">
      {ticks.map((s) => <i key={s} className="tl-grid" style={{ left: `${((s + 0.5) / n) * 100}%` }} />)}
      <div className="tl-bars" style={style}>
        {slots.map((s, i) => (
          <div key={i} className={s.total ? 'tl-col' : 'tl-col empty'}>
            {GROUPS.flatMap((g) => Array.from({ length: s.groups[g.id] }, (_, j) => <b key={`${g.id}${j}`} className={`tl-seg g-${g.id}`} />))}
          </div>
        ))}
      </div>
    </div>
  );
});

const Axis = memo(function Axis({ slots, ticks, max }: { slots: number; ticks: number[]; max: number }) {
  return (
    <div className="tl-axis" aria-hidden="true">
      {ticks.map((s, i) => (
        <span key={s} className={`tl-tick${i % 2 ? ' alt' : ''}${s === 0 ? ' first' : ''}${s === max ? ' last' : ''}`} style={{ left: `${((s + 0.5) / slots) * 100}%` }}>
          <em>{pad3(s)}</em>
        </span>
      ))}
    </div>
  );
});

// Live UTC clock, ticking on the wall-clock second. Its own state, so only this node re-renders.
function ZuluClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id = 0;
    const next = () => 1000 - (Date.now() % 1000) + 5;
    const tick = () => { setNow(new Date()); id = window.setTimeout(tick, next()); };
    id = window.setTimeout(tick, next());
    return () => window.clearTimeout(id);
  }, []);
  const iso = now.toISOString();
  return <time className="tl-zulu" dateTime={iso} aria-label="Current UTC time">{iso.slice(11, 19)}<span>Z</span></time>;
}

export default function Timeline({ t, max, playing, onT, onPlay, marks = [], events }: Props) {
  const scrubRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<number | null>(null);

  // The parent may rebuild `events` every render, so key the buckets on their content (a string), not their identity.
  const sig = (events ?? marks.map((m) => ({ t: m, kind: 'mark' }))).map((e) => `${e.t}:${e.kind}`).join('|');
  const { slots, cum, peak, total } = useMemo(() => {
    const list = sig ? sig.split('|').map((p) => ({ t: Number(p.slice(0, p.indexOf(':'))), kind: p.slice(p.indexOf(':') + 1) })) : [];
    return bucket(list, max);
  }, [sig, max]);
  const n = slots.length;
  const ticks = useMemo(() => {
    const step = tickStep(max);
    return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  }, [max]);

  const cur = Math.min(Math.max(0, Math.round(t)), n - 1);
  const slotAt = (clientX: number) => {
    const r = scrubRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return cur;
    return Math.min(max, Math.max(0, Math.floor(((clientX - r.left) / r.width) * n)));
  };
  const scrubTo = (clientX: number) => { const s = slotAt(clientX); if (s !== t) onT(s); };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    setHover(slotAt(e.clientX));
    scrubTo(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    setHover(slotAt(e.clientX));
    if (dragging.current) scrubTo(e.clientX);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.pointerType !== 'mouse') setHover(null);
  };

  const pct = (slot: number) => `${(slot / n) * 100}%`;
  const hovered = hover !== null ? slots[Math.min(n - 1, hover)] : null;
  const tipSide = hover === null ? 'c' : hover / n < 0.14 ? 'l' : hover / n > 0.86 ? 'r' : 'c';

  return (
    <div className="tl" role="group" aria-label="Scenario timeline">
      <div className="tl-ctl">
        <button className="tl-play" onClick={() => onPlay(!playing)} title="Play / pause (space)" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="tl-speed">4×</span>
      </div>

      <div className="tl-track">
        <div className="tl-legend" aria-hidden="true">
          {GROUPS.map((g) => <span key={g.id} className={`tl-key g-${g.id}`}>{g.label}</span>)}
          <span className="tl-count">{pad2(cum[cur])}/{pad2(total)} alerts</span>
        </div>

        <div
          className="tl-scrub"
          ref={scrubRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={(e) => { if (!dragging.current && e.pointerType === 'mouse') setHover(null); }}
        >
          <Histogram slots={slots} peak={peak} ticks={ticks} />
          <Axis slots={n} ticks={ticks} max={max} />
          <div className="tl-future" style={{ left: pct(cur + 1) }} aria-hidden="true" />
          {hover !== null && hover !== cur && <div className="tl-ghost" style={{ left: pct(hover + 0.5) }} aria-hidden="true" />}
          <div className="tl-cursor" style={{ left: pct(cur + 0.5) }} aria-hidden="true" />
          {hovered && hover !== null && (
            <div className={`tl-tip ${tipSide}`} style={{ left: pct(hover + 0.5) }} aria-hidden="true">
              <strong>T+{pad3(hover)}</strong>
              {hovered.total === 0
                ? <span className="none">No alerts</span>
                : GROUPS.flatMap((g) => Object.entries(hovered.kinds).filter(([k]) => groupOf(k) === g.id).map(([k, c]) => (
                    <span key={k} className={`tl-key g-${g.id}`}>{kindLabel(k)}{c > 1 ? ` ×${c}` : ''}</span>
                  )))}
            </div>
          )}
          <input
            className="tl-range"
            type="range"
            min={0}
            max={max}
            step={1}
            value={t}
            onChange={(e) => onT(Number(e.target.value))}
            aria-label="Scenario time"
            aria-valuetext={`T+${pad3(t)} of ${pad3(max)} seconds`}
          />
          <span className="tl-ring" aria-hidden="true" />
        </div>
      </div>

      <div className="tl-clock">
        <ZuluClock />
        <output className="tl-t" aria-live="off">T+{pad3(t)} <small>/ {pad3(max)} S</small></output>
      </div>
    </div>
  );
}
