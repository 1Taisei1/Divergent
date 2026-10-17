import { useState } from 'react';
import { explain, reconAbort, reconApprove, reconPropose } from './data';
import { pad3 } from './drones';
import { pct } from './geo';
import type { Layers, LayerKey } from './MapView';
import { frameAt, LAYERS } from './MapView';
import type { Alert, AlertKind, ReconRoute, Scenario } from './types';

export function LayersTab({ scenario, layers, setLayers }: { scenario: Scenario; layers: Layers; setLayers: (l: Layers) => void }) {
  const sites = scenario.launch_site_options ?? [];
  return (
    <div className="panel">
      {(Object.keys(LAYERS) as LayerKey[]).map((k) => (
        <label key={k} className="toggle">
          <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
          <span>{LAYERS[k]}</span>
        </label>
      ))}
      <div className="legend" role="list" aria-label="Legend">
        <div role="listitem"><i className="lg-quad hostile" /> Hostile drone</div>
        <div role="listitem"><i className="lg-quad friendly" /> Survey drone</div>
        <div role="listitem"><i className="lg-box allied" /> Allied sensor</div>
        <div role="listitem"><i className="lg-box enemy" /> Enemy sensor</div>
        <div role="listitem"><i className="lg-dot det" /> Detection</div>
        <div role="listitem"><i className="lg-dot clutter" /> Clutter</div>
        <div role="listitem"><i className="lg-ret" /> Estimated launch site</div>
        <div role="listitem"><i className="lg-fill forecast" /> Next-launch forecast</div>
        <div role="listitem"><i className="lg-box safe" /> Our safe launch area</div>
      </div>
      {sites.length > 0 && (
        <div className="sites">
          <div className="alert-meta">Our safest launch sites (hardest for enemy sensors to trace back)</div>
          {sites.map((o, i) => (
            <div key={i} className="site-row">
              <span className="launch-site small">{i + 1}</span>
              <div><b>({o.x}, {o.y}) m · {pct(o.concealment)}</b><div className="hint">{o.reason}</div></div>
            </div>
          ))}
        </div>
      )}
      <p className="hint">Click a drone to see which sensors fed its track. Right-click an allied sensor for a what-if.</p>
    </div>
  );
}

export function alertsUpTo(s: Scenario, t: number): Alert[] {
  return s.frames.filter((f) => f.t <= t).flatMap((f) => f.alerts).sort((a, b) => b.t - a.t);
}

// Military message precedence: what needs a decision now sits on top, routine track bookkeeping at the bottom.
const PRECEDENCE: Record<AlertKind, 0 | 1 | 2> = {
  route_exposed: 2, recon_auto_return: 2,
  origin_confident: 1, launch_team_moved: 1, launch_forecast: 1, launch_site_confirmed: 1,
  new_track: 0, track_lost: 0,
};
const PRECEDENCE_LABEL = ['Routine', 'Priority', 'Immediate'] as const;
export const alertKey = (a: Alert) => `${a.t}|${a.kind}|${a.ref_id}|${a.message}`;

type AlertsProps = { scenario: Scenario; t: number; onJump: (t: number) => void; acked: Set<string>; onAck: (key: string) => void };

export function AlertsTab({ scenario, t, onJump, acked, onAck }: AlertsProps) {
  const alerts = alertsUpTo(scenario, t);
  if (!alerts.length) return <div className="panel empty">No alerts yet at t = {t} s.</div>;
  // Open alerts: highest precedence first, newest first within a precedence. Acknowledged ones drop to the bottom.
  const open = alerts.filter((a) => !acked.has(alertKey(a))).sort((a, b) => PRECEDENCE[b.kind] - PRECEDENCE[a.kind] || b.t - a.t);
  const done = alerts.filter((a) => acked.has(alertKey(a)));
  const immediate = open.filter((a) => PRECEDENCE[a.kind] === 2).length;
  const row = (a: Alert, isDone: boolean) => {
    const p = PRECEDENCE[a.kind];
    return (
      <div key={alertKey(a)} className={`alert kind-${a.kind} prec-${p}${isDone ? ' is-acked' : ''}`}>
        <button className="alert-body" onClick={() => onJump(a.t)} title={`Jump to T+${pad3(a.t)}`}>
          <div className="alert-meta">
            <span className={`prec prec-${p}`}>{PRECEDENCE_LABEL[p]}</span>
            <span className="tcode">T+{pad3(a.t)}</span><span className="kind">{a.kind.replace(/_/g, ' ')}</span>
          </div>
          <div className="alert-msg">{a.message}</div>
          {!isDone && <div className="alert-action"><span aria-hidden="true">&gt;&gt; </span>{a.recommended_action}</div>}
        </button>
        {!isDone && <button className="ack" onClick={() => onAck(alertKey(a))} title="Acknowledge: I have seen this">Ack</button>}
      </div>
    );
  };
  return (
    <div className="panel">
      <div className={`queue-head${immediate ? ' hot' : ''}`}>
        <b>{open.length}</b> open{immediate ? <> · <b>{immediate}</b> immediate</> : null}
        {open.length > 1 && <button className="ghost small" onClick={() => open.forEach((a) => onAck(alertKey(a)))}>Ack all</button>}
      </div>
      {open.map((a) => row(a, false))}
      {!open.length && <p className="hint">All alerts acknowledged.</p>}
      {done.length > 0 && <div className="alert-meta acked-head">Acknowledged ({done.length})</div>}
      {done.map((a) => row(a, true))}
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
        {live ? 'Survey in progress' : `Propose survey at t = ${t} s`}
      </button>
      {err && <div className="error">{err}</div>}
      {route && (
        <div className="survey">
          <div className="stats">
            <div><span>Info gain</span><b>{pct(route.info_gain)}</b></div>
            <div><span>Route risk</span><b className={route.risk > 0.6 ? 'bad' : route.risk > 0.33 ? 'warn' : 'ok'}>{pct(route.risk)}</b></div>
            <div><span>Status</span><b>{now?.status ?? route.status}</b></div>
          </div>
          {now && <div className="alert-meta">Drone at ({Math.round(now.x)}, {Math.round(now.y)}) m · risk now {pct(now.risk_now)}</div>}
          {(frameAt(scenario, t)?.confirmed_sites ?? []).map((c) => (
            <div key={c.team_id} className="confirmed">
              ✓ {c.team_id} launch site confirmed at ({Math.round(c.x)}, {Math.round(c.y)}) m ±{Math.round(c.radius_m)} m
              <div className="alert-meta">first seen t = {c.first_seen_t} s by {c.source}</div>
            </div>
          ))}
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
            {route.approved_by && (
              <div>Approved by <b>{route.approved_by}</b>{' '}
                {typeof route.approved_at === 'number' ? `at T+${pad3(route.approved_at)}`
                  : route.approved_at ? `at ${new Date(route.approved_at).toLocaleTimeString()}` : ''}
              </div>
            )}
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
