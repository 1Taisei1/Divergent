import { useState } from 'react';
import { searchAreaKm2, sitesOf } from './backtrack';
import { explain, reconAbort, reconApprove, reconPropose } from './data';
import { pad3 } from './drones';
import { pct } from './geo';
import type { Layers, LayerKey } from './MapView';
import { frameAt, LAYERS } from './MapView';
import type { Alert, AlertKind, ReconRoute, Scenario } from './types';

// One click per question instead of 17 checkboxes; the full list stays one click away.
const PRESETS: { id: string; label: string; hint: string; keys: LayerKey[] | 'all' }[] = [
  { id: 'enemy', label: 'Enemy picture', hint: 'Where hostile drones came from and will launch next',
    keys: ['sensors', 'detections', 'tracks', 'origins', 'backtrack', 'originHeat', 'forecast', 'launchTeams', 'recon'] },
  { id: 'ours', label: 'Our side', hint: 'Our routes, exposure, safe launch sites, sensor gaps',
    keys: ['sensors', 'exposure', 'routes', 'suggestion', 'launchSites', 'recon'] },
  { id: 'all', label: 'Everything', hint: 'Every layer except the concealment wash', keys: 'all' },
];
const presetLayers = (keys: LayerKey[] | 'all'): Layers =>
  Object.fromEntries((Object.keys(LAYERS) as LayerKey[]).map((k) => [k, keys === 'all' ? k !== 'launchHeat' : keys.includes(k)])) as Layers;
const samePreset = (a: Layers, b: Layers) => (Object.keys(LAYERS) as LayerKey[]).every((k) => a[k] === b[k]);

export function LayersTab({ scenario, layers, setLayers }: { scenario: Scenario; layers: Layers; setLayers: (l: Layers) => void }) {
  const sites = scenario.launch_site_options ?? [];
  const [all, setAll] = useState(false);
  return (
    <div className="panel">
      <div className="presets" role="group" aria-label="What to show">
        {PRESETS.map((pr) => {
          const on = samePreset(layers, presetLayers(pr.keys));
          return (
            <button key={pr.id} className={`preset${on ? ' on' : ''}`} aria-pressed={on} title={pr.hint} onClick={() => setLayers(presetLayers(pr.keys))}>
              {pr.label}
            </button>
          );
        })}
      </div>
      <button className="ghost small expander" aria-expanded={all} onClick={() => setAll((v) => !v)}>
        {all ? 'Hide individual layers' : 'All layers…'}
      </button>
      {all && (Object.keys(LAYERS) as LayerKey[]).map((k) => (
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
      {sites.length > 0 && layers.launchSites && (
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

const SHOW_OPEN = 5;

export function AlertsTab({ scenario, t, onJump, acked, onAck }: AlertsProps) {
  const [more, setMore] = useState(false);
  const alerts = alertsUpTo(scenario, t);
  if (!alerts.length) return <div className="panel"><Explain scenario={scenario} t={t} /><p className="hint">No alerts yet at T+{pad3(t)}.</p></div>;
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
      <Explain scenario={scenario} t={t} />
      <div className={`queue-head${immediate ? ' hot' : ''}`}>
        <b>{open.length}</b> open{immediate ? <> · <b>{immediate}</b> immediate</> : null}
        {open.length > 1 && <button className="ghost small" onClick={() => open.forEach((a) => onAck(alertKey(a)))}>Ack all</button>}
      </div>
      {(more ? open : open.slice(0, SHOW_OPEN)).map((a) => row(a, false))}
      {!open.length && <p className="hint">All alerts acknowledged.</p>}
      {(open.length > SHOW_OPEN || done.length > 0) && (
        <button className="ghost small expander" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {more ? 'Show fewer' : `Show ${Math.max(0, open.length - SHOW_OPEN) ? `${open.length - SHOW_OPEN} more` : ''}${open.length > SHOW_OPEN && done.length ? ' + ' : ''}${done.length ? `${done.length} acknowledged` : ''}`}
        </button>
      )}
      {more && done.length > 0 && <div className="alert-meta acked-head">Acknowledged ({done.length})</div>}
      {more && done.map((a) => row(a, true))}
    </div>
  );
}

// Plain-language summary of the current moment; sits at the top of the Alerts tab.
function Explain({ scenario, t }: { scenario: Scenario; t: number }) {
  const [text, setText] = useState<{ t: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { setText({ t, text: await explain(scenario, t) }); } catch (e) { setErr(String(e)); }
    setBusy(false);
  };
  return (
    <div className="explain-box">
      <button className="primary" onClick={go} disabled={busy} title="AI summary for an operator. It recommends; a human decides.">
        {busy ? 'Explaining…' : `Explain this moment (T+${pad3(t)})`}
      </button>
      {err && <div className="error">{err}</div>}
      {text && (
        <div className="explain">
          <div className="alert-meta">At T+{pad3(text.t)} · recommendation only</div>
          {text.text.split('\n').filter(Boolean).map((l, i) => <p key={i}>{l}</p>)}
        </div>
      )}
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

// How fast the search for launch sites narrows: computed from the frames, so it follows the slider.
function Backtrack({ scenario, t }: { scenario: Scenario; t: number }) {
  const series = scenario.frames.map((f) => ({ t: f.t, a: searchAreaKm2(f), sites: sitesOf(f).length }));
  const upto = series.filter((p) => p.t <= t);
  const peak = upto.reduce((m, p) => (p.a > m.a ? p : m), { t: 0, a: 0, sites: 0 });
  const now = upto[upto.length - 1] ?? { t, a: 0, sites: 0 };
  const firstFix = series.find((p) => p.sites > 0);
  const agreeing = sitesOf(frameAt(scenario, t)).reduce((n, s) => n + s.trackIds.length, 0);
  const W = 300, H = 70, P = 6;
  const aMax = Math.max(0.01, ...series.map((p) => p.a));
  const tMax = Math.max(1, scenario.frames.length - 1);
  const sx = (x: number) => P + ((W - 2 * P) * x) / tMax;
  const sy = (a: number) => H - P - ((H - 2 * P) * a) / aMax;
  const km2 = (a: number) => (a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2));
  return (
    <div className="backtrack">
      <div className="alert-meta">Backtrack: where the drones came from</div>
      <div className="big-numbers">
        <div><span>Search area now</span><b className={now.a < peak.a ? 'ok' : ''}>{km2(now.a)} km²</b></div>
        <div><span>Search area at peak</span><b>{km2(peak.a)} km²</b></div>
        <div><span>Sites located</span><b>{now.sites}</b></div>
        <div><span>First fix</span><b>{firstFix && firstFix.t <= t ? `T+${pad3(firstFix.t)}` : '–'}</b></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Search area over time">
        <polyline points={upto.map((p) => `${sx(p.t)},${sy(p.a)}`).join(' ')} className="line" />
        <line x1={sx(Math.min(t, tMax))} y1={P} x2={sx(Math.min(t, tMax))} y2={H - P} className="now" />
      </svg>
      <p className="hint">
        {agreeing
          ? `${agreeing} drones' backward rays agree on ${now.sites} site${now.sites === 1 ? '' : 's'}. No radio signal needed: only the drones' motion.`
          : 'Each drone alone gives a direction back (cone). Three that agree pin the launch site.'}
      </p>
    </div>
  );
}

export function MetricsTab({ scenario, t }: { scenario: Scenario; t: number }) {
  const m = scenario.metrics;
  if (!m) return <div className="panel"><Backtrack scenario={scenario} t={t} /></div>;
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
      <Backtrack scenario={scenario} t={t} />
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
