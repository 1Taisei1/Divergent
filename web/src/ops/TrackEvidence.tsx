// Threat level that grows with evidence: a contact's ID confidence climbs with every fix and every extra sensor
// (UNKNOWN below 50%, HOSTILE above), alongside its launch-origin confidence. Data comes straight from the frames,
// the same lineage the Provenance tab shows.
import { useMemo } from 'react';
import { frameAt } from '../MapView';
import type { Scenario } from '../types';
import { affiliationOf, AFFIL, HOSTILE_AT, natoSvg, trackConfidence } from './symbols';
import './evidence.css';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const pad3 = (n: number) => String(Math.max(0, Math.round(n))).padStart(3, '0');
const colorOf = (v: number) => (v >= HOSTILE_AT ? AFFIL.hostile.stroke : AFFIL.unknown.stroke);

export function ConfMeter({ value }: { value: number }) {
  const on = value > 0 ? Math.ceil(value * 5) : 0;
  return (
    <span className="ev-meter" role="img" aria-label={`Confidence ${pct(value)}`}>
      {[0, 1, 2, 3, 4].map((i) => <i key={i} style={i < on ? { background: colorOf(value) } : undefined} />)}
    </span>
  );
}

type Sample = { t: number; fixes: number; sensors: number; id: number; origin: number | null; radius: number | null };

export function EvidenceTrend({ scenario, trackId, t }: { scenario: Scenario; trackId: string; t: number }) {
  const series = useMemo(() => {
    const out: Sample[] = [];
    for (let sec = 0; sec <= t; sec++) {
      const f = frameAt(scenario, sec);
      const tr = f?.tracks.find((x) => x.id === trackId);
      if (!f || !tr) continue;
      const fixes = tr.points.filter((q) => q.t <= sec).length || tr.points.length;
      const o = f.origins.find((x) => x.track_id === trackId);
      out.push({ t: sec, fixes, sensors: tr.sensor_ids.length, id: trackConfidence(fixes, tr.sensor_ids.length), origin: o?.confidence ?? null, radius: o?.radius_m ?? null });
    }
    return out;
  }, [scenario, trackId, t]);

  if (!series.length) return null;
  const now = series[series.length - 1];
  const t0 = series[0].t, t1 = Math.max(t0 + 1, now.t);
  const W = 260, H = 70, x = (sec: number) => ((sec - t0) / (t1 - t0)) * W, y = (v: number) => H - 4 - v * (H - 8);
  const crossed = series.find((p) => p.id >= HOSTILE_AT);
  const updates = series.filter((p, i) => p.origin !== null && (i === 0 || p.origin !== series[i - 1].origin)).slice(-4).reverse();
  // Step segments, each coloured by the affiliation it implied at the time.
  const idSegs = series.slice(1).map((p, i) => ({ a: series[i], b: p }));
  const originPts = series.filter((p) => p.origin !== null).map((p) => `${x(p.t).toFixed(1)},${y(p.origin!).toFixed(1)}`).join(' ');
  const aff = affiliationOf(now.id);

  return (
    <div className="ev">
      <div className="ev-head">
        <span className="ev-aff"><i dangerouslySetInnerHTML={{ __html: natoSvg(aff, 16) }} />{AFFIL[aff].label} · {now.fixes} fixes · {now.sensors} sensor{now.sensors === 1 ? '' : 's'}</span>
        <span className="ev-now"><b style={{ color: colorOf(now.id) }}>ID {pct(now.id)}</b> <b className="ev-origin">ORIGIN {now.origin !== null ? pct(now.origin) : '–'}</b></span>
      </div>
      <svg className="ev-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`ID confidence ${pct(now.id)}, origin confidence ${now.origin !== null ? pct(now.origin) : 'none yet'}`}>
        <line x1="0" x2={W} y1={y(HOSTILE_AT)} y2={y(HOSTILE_AT)} className="ev-thresh" />
        <text x={W - 2} y={y(HOSTILE_AT) - 3} textAnchor="end" className="ev-tlabel">HOSTILE 50%</text>
        {idSegs.map(({ a, b }) => (
          <path key={a.t} d={`M${x(a.t).toFixed(1)} ${y(a.id).toFixed(1)} H${x(b.t).toFixed(1)} V${y(b.id).toFixed(1)}`} stroke={colorOf(a.id)} className="ev-id" />
        ))}
        {originPts && <polyline points={originPts} className="ev-orig" />}
        {crossed && crossed.t > t0 && (
          <g>
            <line x1={x(crossed.t)} x2={x(crossed.t)} y1="4" y2={H} className="ev-cross" />
            <text x={Math.min(W - 4, x(crossed.t) + 3)} y="12" textAnchor={x(crossed.t) > W * 0.6 ? 'end' : 'start'} className="ev-tlabel ev-hostile">UNKNOWN → HOSTILE T+{pad3(crossed.t)}</text>
          </g>
        )}
      </svg>
      <div className="ev-axis"><span>T+{pad3(t0)}</span><span>T+{pad3(now.t)}</span></div>
      {updates.length > 0 && (
        <ol className="ev-updates" aria-label="Origin estimate updates">
          {updates.map((u) => <li key={u.t}><time>T+{pad3(u.t)}</time><b>{pct(u.origin ?? 0)}</b><span>±{Math.round(u.radius ?? 0)} M</span></li>)}
        </ol>
      )}
      <p className="ev-cap">Confidence climbs with every fix and every extra sensor. Below 50% the contact stays UNKNOWN.</p>
    </div>
  );
}
