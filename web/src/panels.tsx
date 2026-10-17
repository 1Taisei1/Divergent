import { useState } from 'react';
import { explain, reconAbort, reconApprove, reconPropose } from './data';
import { pct } from './geo';
import type { Layers, LayerKey } from './MapView';
import { frameAt, LAYERS } from './MapView';
import type { Alert, ReconRoute, Scenario } from './types';

export function LayersTab({ layers, setLayers }: { layers: Layers; setLayers: (l: Layers) => void }) {
  return (
    <div className="panel">
      {(Object.keys(LAYERS) as LayerKey[]).map((k) => (
        <label key={k} className="toggle">
          <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
          <span>{LAYERS[k]}</span>
        </label>
      ))}
      <div className="legend">
        <div><i style={{ background: '#4da3ff' }} /> Allied sensor</div>
        <div><i style={{ background: '#ff4d4d' }} /> Enemy sensor</div>
        <div><i style={{ background: '#7ff0ff' }} /> Detection</div>
        <div><i style={{ background: '#8a8f98' }} /> Clutter</div>
        <div><i style={{ background: '#ffe14d' }} /> Track</div>
        <div><i style={{ background: '#ff8a3d' }} /> Likely launch area</div>
        <div><i style={{ background: '#a070ff' }} /> Next-launch forecast</div>
      </div>
      <p className="hint">Click a track to see which sensors fed it. Right-click an allied sensor for what-if.</p>
    </div>
  );
}

export function alertsUpTo(s: Scenario, t: number): Alert[] {
  return s.frames.filter((f) => f.t <= t).flatMap((f) => f.alerts).sort((a, b) => b.t - a.t);
}

export function AlertsTab({ scenario, t, onJump }: { scenario: Scenario; t: number; onJump: (t: number) => void }) {
  const alerts = alertsUpTo(scenario, t);
  if (!alerts.length) return <div className="panel empty">No alerts yet at t = {t} s.</div>;
  return (
    <div className="panel">
      {alerts.map((a, i) => (
        <button key={i} className={`alert kind-${a.kind}`} onClick={() => onJump(a.t)}>
          <div className="alert-meta">t = {a.t} s · {a.kind.replace(/_/g, ' ')}</div>
          <div>{a.message}</div>
          <div className="alert-action"><b>{a.recommended_action}</b></div>
        </button>
      ))}
    </div>
  );
}

export function ExplainTab({ scenario, t }: { scenario: Scenario; t: number }) {
  const [text, setText] = useState<{ t: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { setText({ t, text: await explain(scenario, t) }); } catch (e) { setErr(String(e)); }
    setBusy(false);
  };
  return (
    <div className="panel">
      <button className="primary" onClick={go} disabled={busy}>{busy ? 'Explaining…' : `Explain the picture at t = ${t} s`}</button>
      {err && <div className="error">{err}</div>}
      {text && (
        <div className="explain">
          <div className="alert-meta">At t = {text.t} s</div>
          {text.text.split('\n').filter(Boolean).map((l, i) => <p key={i}>{l}</p>)}
        </div>
      )}
      <p className="hint">AI summary for an operator. It recommends; a human decides.</p>
    </div>
  );
}

type SurveyProps = {
  scenario: Scenario;
  t: number;
  proposed: ReconRoute | null;
  setProposed: (r: ReconRoute | null, t: number) => void;
  proposedAt: number;
  onScenario: (s: Scenario, playFrom: number | null) => void;
};

export function SurveyTab({ scenario, t, proposed, setProposed, proposedAt, onScenario }: SurveyProps) {
  const [operator, setOperator] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const live = scenario.recon_route && scenario.recon_route.status !== 'proposed' ? scenario.recon_route : null;
  const route = live ?? proposed;
  const now = frameAt(scenario, t)?.recon;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      <p className="hint">Surveillance only. A survey drone never moves until a named operator approves it, stays inside its geofence, and returns home automatically if risk gets too high.</p>
      <button className="primary" disabled={busy || !!live} onClick={() => run(async () => setProposed(await reconPropose(scenario, t), t))}>
        Propose survey at t = {t} s
      </button>
      {err && <div className="error">{err}</div>}
      {route && (
        <div className="survey">
          <div className="stats">
            <div><span>Info gain</span><b>{pct(route.info_gain)}</b></div>
            <div><span>Route risk</span><b className={route.risk > 0.6 ? 'bad' : route.risk > 0.33 ? 'warn' : 'ok'}>{pct(route.risk)}</b></div>
            <div><span>Status</span><b>{now?.status ?? route.status}</b></div>
          </div>
          {now && <div className="alert-meta">Drone at ({now.x}, {now.y}) m · risk now {pct(now.risk_now)}</div>}
          {!live && (
            <>
              <label className="field">Operator name
                <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Your name" />
              </label>
              <button className="approve" disabled={busy || !operator.trim()}
                onClick={() => run(async () => { onScenario(await reconApprove(scenario, route, operator, proposedAt), proposedAt); })}>
                Approve survey
              </button>
              <button className="ghost" disabled={busy} onClick={() => setProposed(null, t)}>Discard</button>
            </>
          )}
          {live && (
            <button className="abort" disabled={busy || route.status === 'aborted' || now?.status === 'returned'}
              onClick={() => run(async () => { onScenario(await reconAbort(scenario, route, t), null); })}>
              Abort → return home
            </button>
          )}
          <div className="log">
            <div className="alert-meta">Log</div>
            {route.log.filter((e) => e.t <= t).map((e, i) => <div key={i}>t = {e.t} s · {e.event}{e.by ? ` by ${e.by}` : ''}</div>)}
            {route.approved_by && <div>Approved by <b>{route.approved_by}</b> at t = {route.approved_at} s</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// The API may send null for a metric it couldn't compute; show a dash rather than a misleading 0.
const num = (v: number | null | undefined, unit: string) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}${unit}` : '–');

export function MetricsTab({ scenario, t }: { scenario: Scenario; t: number }) {
  const m = scenario.metrics;
  if (!m) return <div className="panel empty">No metrics for this scenario yet.</div>;
  const pts = Object.entries(m.origin_error_m_by_t ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => ({ t: Number(k), v })).sort((a, b) => a.t - b.t);
  const first = pts.find((p) => p.t === 30) ?? pts[0];
  const now = [...pts].reverse().find((p) => p.t <= t) ?? pts[pts.length - 1];
  const W = 300, H = 120, P = 24;
  const tMax = Math.max(scenario.duration_s, ...pts.map((p) => p.t));
  const vMax = Math.max(1, ...pts.map((p) => p.v));
  const sx = (x: number) => P + ((W - 2 * P) * x) / tMax;
  const sy = (v: number) => H - P - ((H - 2 * P) * v) / vMax;
  return (
    <div className="panel">
      <div className="big-numbers">
        <div><span>Origin error at t = {first?.t ?? '–'} s</span><b>{first ? `${Math.round(first.v)} m` : '–'}</b></div>
        <div><span>Origin error at t = {now?.t ?? '–'} s</span><b className={now && first && now.t !== first.t ? (now.v <= first.v ? 'ok' : 'bad') : ''}>{now ? `${Math.round(now.v)} m` : '–'}</b></div>
        <div><span>Track RMSE</span><b>{num(m.track_rmse_m, ' m')}</b></div>
        <div><span>Clutter filtered</span><b>{num(m.clutter_filtered_pct, '%')}</b></div>
      </div>
      {pts.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Origin error over time">
          <line x1={P} y1={H - P} x2={W - P} y2={H - P} className="axis" />
          <line x1={sx(Math.min(t, tMax))} y1={P / 2} x2={sx(Math.min(t, tMax))} y2={H - P} className="now" />
          <polyline points={pts.map((p) => `${sx(p.t)},${sy(p.v)}`).join(' ')} className="line" />
          {pts.map((p) => (
            <g key={p.t}>
              <circle cx={sx(p.t)} cy={sy(p.v)} r={3.5} className="dot" />
              <text x={sx(p.t)} y={sy(p.v) - 8} textAnchor="middle">{Math.round(p.v)}</text>
              <text x={sx(p.t)} y={H - 6} textAnchor="middle" className="tick">{p.t}s</text>
            </g>
          ))}
        </svg>
      )}
      <p className="hint">{m.label}</p>
    </div>
  );
}
