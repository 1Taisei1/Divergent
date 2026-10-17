import { useMemo, useState, type MouseEvent } from 'react';
import { isGrid } from '../types';
import type {
  Alert, AlertKind, ConfirmedSite, Detection, Frame, LaunchTeam, ReconRoute, ReconStatus, Scenario, Side, TimedPoint, TrackStatus,
} from '../types';
import './provenance.css';

type Props = {
  scenario: Scenario;
  t: number;
  onJump: (t: number) => void;
  onSelectTrack: (id: string) => void;
};

/* ---------- constants mirrored from the analysis modules (used only to explain how a number was made) ---------- */
const FIT_POINTS = 5; // analysis/origin.py
const MIN_POINTS = 3;
const CONFIDENT_AT = 0.7; // analysis/alerts.py
const JOIN_M = 800; // analysis/launch_teams.py
const MOVE_M = 2000;
const MOVE_AFTER_S = 25;
const SIGMA0_M = 400; // analysis/forecast.py
const SIGMA_GROWTH = 15;
const SIGMA_MAX_M = 2000;
const FORECAST_MOVE_M = 400; // forecast peak counts as "moved" beyond this
const MAX_TRACK_ROWS = 20;
const MAX_SENSOR_ROWS = 14;

/* ---------- formatting ---------- */
const pad3 = (n: number) => String(Math.round(n)).padStart(3, '0');
const T = (n: number) => `T+${pad3(n)}`;
const P = (c: number) => `${Math.round(c * 100)}%`;
const num = (v: number) => Math.round(v).toLocaleString('en-US');
const mtr = (v: number) => `${num(v)} m`;
const xy = (p: { x: number; y: number }) => `(${num(p.x)}, ${num(p.y)})`;
const km = (d: number) => (d >= 1000 ? `${(d / 1000).toFixed(1)} km` : mtr(d));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const kindLabel = (k: string) => k.replace(/_/g, ' ');
const TYPE_CODE: Record<string, string> = { radar: 'RAD', acoustic: 'ACO', rf: 'RF', recon: 'REC' };

/** Number of entries with entry.t <= t, for arrays sorted ascending by t. */
function countUpTo(arr: { t: number }[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ---------- derived lineage data: built once per scenario ---------- */
interface SensorRow {
  id: string;
  side: Side;
  type: string;
  range_m: number | null;
  active: boolean;
  real: Uint16Array;
  clutter: Uint16Array;
  cumReal: Int32Array; // length n + 1
  cumClutter: Int32Array;
  pathReal: string;
  pathClutter: string;
}

interface TrackRec {
  id: string;
  points: TimedPoint[];
  first: number; // first fix
  lastFix: number;
  present1: number; // last frame the track appears in
  runs: { t: number; status: TrackStatus }[];
  dets: Detection[]; // the non-clutter detections the tracker fused, sorted by t
}

interface OriginEv { t: number; conf: number; radius: number; x: number; y: number }

interface Move { i: number; t: number; x: number; y: number; d: number; kind: 'found' | 'reloc' | 'same'; trackId: string | null }
interface TeamRec { id: string; first: number; final: LaunchTeam; moves: Move[] }

interface ReconSpan { status: ReconStatus; t0: number; t1: number; routeId: string }

interface Derived {
  end: number;
  n: number;
  frameAt: (t: number) => Frame | undefined;
  sensors: SensorRow[];
  sensorById: Map<string, SensorRow>;
  detCum: Int32Array; // all detections (clutter included) with t <= i, length n + 1
  clutCum: Int32Array;
  tracks: TrackRec[];
  trackById: Map<string, TrackRec>;
  origins: Map<string, OriginEv[]>;
  teams: TeamRec[];
  fc: { peak: Float32Array; spread: Float32Array; x: Float32Array; y: Float32Array; has: Uint8Array; first: number; moves: { t: number; x: number; y: number }[]; peakMax: number; spreadMax: number };
  alerts: Alert[];
  spans: ReconSpan[];
  sites: ConfirmedSite[];
  routeFirst: Map<string, number>;
  reconRoute: ReconRoute | null;
}

function derive(sc: Scenario): Derived {
  const frames = [...sc.frames].sort((a, b) => a.t - b.t);
  const end = Math.max(sc.duration_s, frames.length ? frames[frames.length - 1].t : 0, 1);
  const n = end + 1;
  const slot = (t: number) => clamp(Math.round(t), 0, end);

  const byT: (Frame | undefined)[] = new Array(n).fill(undefined);
  for (const f of frames) byT[slot(f.t)] = f;
  let prev: Frame | undefined;
  for (let i = 0; i < n; i++) { if (byT[i]) prev = byT[i]; else byT[i] = prev; }

  /* detections: aggregate per sensor per second */
  const sensorMeta = new Map<string, { side: Side; type: string; range_m: number | null; active: boolean }>();
  for (const s of sc.sensors) sensorMeta.set(s.id, { side: s.side, type: s.type, range_m: s.range_m, active: s.active });
  const realBy = new Map<string, Uint16Array>();
  const clutBy = new Map<string, Uint16Array>();
  const seenDet = new Set<string>();
  const detTotal = new Int32Array(n), clutTotal = new Int32Array(n);
  const realByT: Detection[][] = Array.from({ length: n }, () => []);
  const bump = (m: Map<string, Uint16Array>, id: string, s: number) => {
    let a = m.get(id);
    if (!a) { a = new Uint16Array(n); m.set(id, a); }
    a[s] += 1;
  };
  for (const f of frames) {
    for (const d of f.detections) {
      if (seenDet.has(d.id)) continue;
      seenDet.add(d.id);
      const s = slot(Number.isFinite(d.t) ? d.t : f.t);
      detTotal[s] += 1;
      if (d.clutter) { clutTotal[s] += 1; bump(clutBy, d.sensor_id, s); }
      else { bump(realBy, d.sensor_id, s); realByT[s].push(d); }
      if (!sensorMeta.has(d.sensor_id)) sensorMeta.set(d.sensor_id, { side: 'allied', type: 'recon', range_m: null, active: true });
    }
  }
  const detCum = new Int32Array(n + 1), clutCum = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { detCum[i + 1] = detCum[i] + detTotal[i]; clutCum[i + 1] = clutCum[i] + clutTotal[i]; }

  let maxTotal = 1;
  for (const [id] of sensorMeta) {
    const r = realBy.get(id), c = clutBy.get(id);
    for (let i = 0; i < n; i++) maxTotal = Math.max(maxTotal, (r?.[i] ?? 0) + (c?.[i] ?? 0));
  }
  const H = 20, unit = (H - 2) / maxTotal;
  const sensors: SensorRow[] = [...sensorMeta.entries()].map(([id, m]) => {
    const real = realBy.get(id) ?? new Uint16Array(n), clutter = clutBy.get(id) ?? new Uint16Array(n);
    const cumReal = new Int32Array(n + 1), cumClutter = new Int32Array(n + 1);
    let a = '', b = '';
    for (let i = 0; i < n; i++) {
      cumReal[i + 1] = cumReal[i] + real[i];
      cumClutter[i + 1] = cumClutter[i] + clutter[i];
      const hr = real[i] ? Math.max(2, real[i] * unit) : 0;
      const hc = clutter[i] ? Math.max(2, clutter[i] * unit) : 0;
      if (hr) a += `M${i + 0.5} ${H}v${-+hr.toFixed(1)}`;
      if (hc) b += `M${i + 0.5} ${+(H - hr).toFixed(1)}v${-+hc.toFixed(1)}`;
    }
    return { id, ...m, real, clutter, cumReal, cumClutter, pathReal: a, pathClutter: b };
  }).sort((x, y) => (x.side === y.side ? x.id.localeCompare(y.id, undefined, { numeric: true }) : x.side === 'allied' ? -1 : 1));
  const sensorById = new Map(sensors.map((s) => [s.id, s]));

  /* tracks: latest frame holds the full point history; status runs come from the frame sequence */
  const tmap = new Map<string, TrackRec>();
  for (const f of frames) {
    for (const tr of f.tracks) {
      let rec = tmap.get(tr.id);
      if (!rec) { rec = { id: tr.id, points: tr.points, first: 0, lastFix: 0, present1: f.t, runs: [], dets: [] }; tmap.set(tr.id, rec); }
      rec.points = tr.points.length >= rec.points.length ? tr.points : rec.points;
      rec.present1 = f.t;
      const last = rec.runs[rec.runs.length - 1];
      if (!last || last.status !== tr.status) rec.runs.push({ t: f.t, status: tr.status });
    }
  }
  const tracks = [...tmap.values()].filter((r) => r.points.length > 0);
  for (const rec of tracks) {
    rec.first = rec.points[0].t;
    rec.lastFix = rec.points[rec.points.length - 1].t;
    rec.runs[0].t = Math.min(rec.runs[0].t, rec.first);
    rec.dets = associate(rec.points, realByT, n);
  }
  tracks.sort((a, b) => a.first - b.first || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const trackById = new Map(tracks.map((r) => [r.id, r]));

  /* origin estimates: an event whenever a track's estimate first appears or its confidence % changes */
  const origins = new Map<string, OriginEv[]>();
  for (const f of frames) {
    for (const o of f.origins) {
      const list = origins.get(o.track_id) ?? [];
      const last = list[list.length - 1];
      if (!last || Math.round(last.conf * 100) !== Math.round(o.confidence * 100)) {
        list.push({ t: f.t, conf: o.confidence, radius: o.radius_m, x: o.peak.x, y: o.peak.y });
      }
      origins.set(o.track_id, list);
    }
  }

  /* launch teams: final history per team, with relocation distances */
  const teamMap = new Map<string, TeamRec>();
  for (const f of frames) {
    for (const lt of f.launch_teams) {
      const rec = teamMap.get(lt.id);
      if (rec) rec.final = lt; else teamMap.set(lt.id, { id: lt.id, first: f.t, final: lt, moves: [] });
    }
  }
  const teams = [...teamMap.values()];
  for (const rec of teams) {
    const h = rec.final.origin_history;
    const linked = rec.final.track_ids.length === h.length;
    rec.moves = h.map((p, i) => {
      const d = i === 0 ? 0 : dist(p, h[i - 1]);
      return { i, t: p.t, x: p.x, y: p.y, d, kind: i === 0 ? 'found' : d > JOIN_M ? 'reloc' : 'same', trackId: linked ? rec.final.track_ids[i] : null };
    });
    if (h.length) rec.first = Math.min(rec.first, h[0].t);
  }

  /* forecast heat: peak value, hot area, and where the peak sits, per second */
  const fc = {
    peak: new Float32Array(n), spread: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n),
    has: new Uint8Array(n), first: -1, moves: [] as { t: number; x: number; y: number }[], peakMax: 0, spreadMax: 0,
  };
  let anchor: { x: number; y: number } | null = null;
  for (const f of frames) {
    const g = f.forecast_heatmap;
    if (!isGrid(g)) continue;
    let mx = 0, mr = 0, mc = 0;
    for (let r = 0; r < g.values.length; r++) {
      const row = g.values[r];
      for (let c = 0; c < row.length; c++) if (row[c] > mx) { mx = row[c]; mr = r; mc = c; }
    }
    if (mx <= 0) continue;
    let hot = 0;
    const half = mx / 2;
    for (const row of g.values) for (const v of row) if (v >= half) hot += 1;
    const s = slot(f.t);
    const px = (mc + 0.5) * g.cell_m, py = (mr + 0.5) * g.cell_m;
    fc.peak[s] = mx; fc.spread[s] = (hot * g.cell_m * g.cell_m) / 1e6; fc.x[s] = px; fc.y[s] = py; fc.has[s] = 1;
    fc.peakMax = Math.max(fc.peakMax, mx); fc.spreadMax = Math.max(fc.spreadMax, fc.spread[s]);
    if (fc.first < 0) fc.first = s;
    if (!anchor || dist(anchor, { x: px, y: py }) >= FORECAST_MOVE_M) { anchor = { x: px, y: py }; fc.moves.push({ t: s, x: px, y: py }); }
  }

  /* alerts, recon spans, confirmed sites, route first sightings */
  const alerts: Alert[] = [];
  const seenAlert = new Set<string>();
  for (const f of frames) {
    for (const a of f.alerts) {
      const key = `${a.t}|${a.kind}|${a.ref_id}|${a.message}`;
      if (seenAlert.has(key)) continue;
      seenAlert.add(key);
      alerts.push(a);
    }
  }
  alerts.sort((a, b) => a.t - b.t);

  const spans: ReconSpan[] = [];
  for (const f of frames) {
    if (!f.recon) continue;
    const last = spans[spans.length - 1];
    if (last && last.status === f.recon.status && last.routeId === f.recon.route_id && f.t - last.t1 <= 1) last.t1 = f.t;
    else spans.push({ status: f.recon.status, t0: f.t, t1: f.t, routeId: f.recon.route_id });
  }
  const siteMap = new Map<string, ConfirmedSite>();
  for (const f of frames) for (const s of f.confirmed_sites) siteMap.set(s.team_id, s);
  const sites = [...siteMap.values()];
  const routeFirst = new Map<string, number>();
  for (const f of frames) for (const r of f.routes) if (!routeFirst.has(r.id)) routeFirst.set(r.id, f.t);

  return {
    end, n, frameAt: (t) => byT[slot(t)], sensors, sensorById, detCum, clutCum, tracks, trackById, origins, teams, fc,
    alerts, spans, sites, routeFirst, reconRoute: sc.recon_route,
  };
}

/** The non-clutter detections a track fused: vote on the drone behind its fixes, then take that drone's detections. */
function associate(points: TimedPoint[], byT: Detection[][], n: number): Detection[] {
  const votes = new Map<string, number>();
  const nearest: Detection[] = [];
  for (const p of points) {
    const cands = byT[clamp(Math.round(p.t), 0, n - 1)];
    let best: Detection | null = null, bd = Infinity;
    for (const d of cands) {
      const dd = Math.hypot(d.x - p.x, d.y - p.y);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (best && bd < 800) {
      nearest.push(best);
      if (best.truth_drone_id) votes.set(best.truth_drone_id, (votes.get(best.truth_drone_id) ?? 0) + 1);
    }
  }
  let drone: string | null = null, top = 0;
  for (const [id, v] of votes) if (v > top) { top = v; drone = id; }
  if (!drone) return nearest;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const out: Detection[] = [];
  for (let i = 0; i < n; i++) {
    if (i < t0 || i > t1) continue;
    for (const d of byT[i]) if (d.truth_drone_id === drone) out.push(d);
  }
  return out;
}

/* ---------- selection ---------- */
type Sel =
  | { k: 'sensor'; id: string }
  | { k: 'track'; id: string }
  | { k: 'origin'; id: string }
  | { k: 'team'; id: string }
  | { k: 'forecast' }
  | { k: 'alert'; i: number }
  | { k: 'route'; id: string }
  | { k: 'recon' }
  | { k: 'site'; id: string };

function subjectOf(a: Alert): Sel {
  if (a.kind === 'origin_confident') return { k: 'origin', id: a.ref_id };
  if (a.kind === 'launch_team_moved') return { k: 'team', id: a.ref_id };
  if (a.kind === 'launch_site_confirmed') return { k: 'site', id: a.ref_id };
  if (a.kind === 'route_exposed') return { k: 'route', id: a.ref_id };
  if (a.kind === 'recon_auto_return') return { k: 'recon' };
  if (a.kind === 'launch_forecast') return { k: 'forecast' };
  return { k: 'track', id: a.ref_id };
}

/* ---------- inspector model: plain data, built per selection + time ---------- */
interface Row { a: string; b?: string; t?: number; pick?: Sel }
interface Step { role: string; module: string; title: string; text?: string; t?: number; rows?: Row[]; pick?: Sel }
interface Use { text: string; t?: number; pick?: Sel }
interface Insp { chip: string; title: string; meta: string; since: number; steps: Step[]; uses: Use[] }
interface Ctx { D: Derived; at: number; fr: Frame | undefined }

const MOD = {
  sim: 'sim/generate.py',
  tracker: 'analysis/tracker.py',
  origin: 'analysis/origin.py',
  teams: 'analysis/launch_teams.py',
  forecast: 'analysis/forecast.py',
  alerts: 'analysis/alerts.py',
  exposure: 'planning/exposure.py',
  recon: 'planning/recon.py',
  fusion: 'api/recon_fusion.py',
};

const ALERT_RULE: Record<AlertKind, { module: string; rule: string }> = {
  new_track: { module: MOD.alerts, rule: 'Raised the first time a track id appears in a frame.' },
  track_lost: { module: MOD.alerts, rule: 'Raised when a track stops receiving fixes and its status turns lost (tracker drops it after 5 s).' },
  origin_confident: { module: MOD.alerts, rule: `Raised once per track, the first time its origin confidence reaches ${P(CONFIDENT_AT)}.` },
  launch_team_moved: { module: MOD.alerts, rule: 'Raised when a launch team gains a new origin that sits away from its previous one.' },
  launch_forecast: { module: MOD.alerts, rule: 'Raised when the next-launch forecast changes.' },
  route_exposed: { module: MOD.alerts, rule: 'Raised once per friendly route, when its exposure risk level first turns high.' },
  recon_auto_return: { module: MOD.alerts, rule: 'Raised when a survey flight returned early because its risk peaked above 60%.' },
  launch_site_confirmed: { module: MOD.fusion, rule: 'Raised when an approved survey drone sights a team\'s launch site and pins it.' },
};

function detRows(dets: Detection[], upto: number): Row[] {
  const pick = (d: Detection): Row => ({ a: d.id, b: `${d.sensor_id} · ${T(d.t)} · sigma ${mtr(d.sigma_m)}`, t: d.t });
  if (upto <= 6) return dets.slice(0, upto).map(pick);
  return [...dets.slice(0, 3).map(pick), { a: `... ${upto - 5} more` }, ...dets.slice(upto - 2, upto).map(pick)];
}

function trackSteps(c: Ctx, tr: TrackRec, role: string): Step[] {
  const { D, at, fr } = c;
  const nFix = Math.max(1, countUpTo(tr.points, at));
  const nDet = countUpTo(tr.dets, at);
  const used = [...new Set(tr.dets.slice(0, nDet).map((d) => d.sensor_id))];
  const live = fr?.tracks.find((x) => x.id === tr.id);
  const status = live?.status ?? 'active';
  const ell = live?.ellipse;
  const span = `${T(tr.points[0].t)}..${T(tr.points[nFix - 1].t)}`;
  const first = nDet ? tr.dets[0] : null, last = nDet ? tr.dets[nDet - 1] : null;
  return [
    {
      role, module: MOD.tracker, pick: { k: 'track', id: tr.id }, t: tr.points[nFix - 1].t,
      title: `TRACK ${tr.id} · ${status} · ${nFix} fixes ${span}`,
      text: `One constant-velocity Kalman filter per drone fuses ${nDet} detections${used.length ? ` from ${used.join(', ')}` : ''}.`
        + (ell ? ` Uncertainty ellipse ${num(ell.major_m)} x ${num(ell.minor_m)} m.` : '')
        + ' Clutter is never used.',
    },
    {
      role: 'RAW INPUT', module: `${MOD.sim} (simulated)`,
      title: first && last ? `DETECTIONS ${first.id} .. ${last.id} · ${nDet}` : 'DETECTIONS · none matched',
      text: `Each detection is a sensor, a time, a position and a 1-sigma error. ${num(D.clutCum[at + 1])} clutter detections rejected across all sensors so far.`,
      rows: detRows(tr.dets, nDet),
    },
  ];
}

function alertUses(c: Ctx, match: (a: Alert) => boolean): Use[] {
  const out: Use[] = [];
  c.D.alerts.forEach((a, i) => {
    if (a.t <= c.at && match(a)) out.push({ text: `alert ${kindLabel(a.kind)} (${MOD.alerts})`, t: a.t, pick: { k: 'alert', i } });
  });
  return out.slice(-4);
}

function sensorInsp(c: Ctx, id: string): Insp | null {
  const s = c.D.sensorById.get(id);
  if (!s) return null;
  const real = s.cumReal[c.at + 1], clutter = s.cumClutter[c.at + 1];
  const users = c.D.tracks.filter((tr) => countUpTo(tr.dets, c.at) > 0 && tr.dets.some((d) => d.t <= c.at && d.sensor_id === id));
  return {
    chip: 'SENSOR', title: `${s.id} · ${s.side} ${s.type}`, since: 0,
    meta: `${s.range_m ? `range ${mtr(s.range_m)} · ` : ''}${s.active ? 'active' : 'disabled'}`,
    steps: [
      { role: 'OUTPUT', module: MOD.sim, title: `${real} detections + ${clutter} clutter by ${T(c.at)}`, text: `Per-second counts are on the SENSORS lane. Clutter share ${real + clutter ? P(clutter / (real + clutter)) : '0%'}.` },
      { role: 'RAW INPUT', module: `${MOD.sim} (simulated)`, title: 'Simulated sensor model', text: 'Positions carry noise (sigma by sensor type) and false alarms. No real sensor data is used.' },
    ],
    uses: s.side === 'enemy'
      ? [{ text: `friendly route exposure is scored against this sensor's coverage (${MOD.exposure})` }]
      : users.map((tr) => ({ text: `fused into track ${tr.id} (${MOD.tracker})`, pick: { k: 'track', id: tr.id } as Sel })),
  };
}

function trackInsp(c: Ctx, id: string): Insp | null {
  const tr = c.D.trackById.get(id);
  if (!tr) return null;
  const uses: Use[] = [];
  const evs = c.D.origins.get(id);
  if (evs && evs[0].t <= c.at) {
    const ev = evs[countUpTo(evs, c.at) - 1];
    uses.push({ text: `feeds origin estimate ${P(ev.conf)} ±${mtr(ev.radius)} (${MOD.origin})`, t: evs[0].t, pick: { k: 'origin', id } });
  }
  const team = c.fr?.launch_teams.find((lt) => lt.track_ids.includes(id));
  if (team) uses.push({ text: `member of launch team ${team.id} (${MOD.teams})`, pick: { k: 'team', id: team.id } });
  uses.push(...alertUses(c, (a) => a.ref_id === id));
  return {
    chip: 'TRACK', title: `TRACK ${id}`, since: tr.first,
    meta: `${T(tr.first)} first fix · ${T(tr.lastFix)} last fix`,
    steps: trackSteps(c, tr, 'OUTPUT'), uses,
  };
}

function originInsp(c: Ctx, id: string): Insp | null {
  const { D, at } = c;
  const tr = D.trackById.get(id), evs = D.origins.get(id);
  if (!tr || !evs || !evs.length) return null;
  const upto = Math.max(1, countUpTo(evs, at));
  const ev = evs[upto - 1];
  const nFix = Math.min(FIT_POINTS, countUpTo(tr.points, ev.t));
  const window = nFix ? `${T(tr.points[0].t)}..${T(tr.points[nFix - 1].t)}` : '';
  const history: Row[] = evs.slice(0, upto).map((e) => ({ a: T(e.t), b: `${P(e.conf)} ±${mtr(e.radius)}`, t: e.t }));
  const rows = history.length > 8 ? [...history.slice(0, 2), { a: `... ${history.length - 5} more` }, ...history.slice(-3)] : history;
  const uses: Use[] = [];
  const team = c.fr?.launch_teams.find((lt) => lt.track_ids.includes(id));
  if (team) uses.push({ text: `feeds launch team ${team.id} (${MOD.teams}); its history is what the forecast projects forward`, pick: { k: 'team', id: team.id } });
  uses.push(...alertUses(c, (a) => a.ref_id === id && a.kind === 'origin_confident'));
  const site = team ? D.sites.find((s) => s.team_id === team.id && s.first_seen_t <= at) : undefined;
  if (site) uses.push({ text: `pinned by survey ${site.source} (${MOD.fusion})`, t: site.first_seen_t, pick: { k: 'site', id: site.team_id } });
  return {
    chip: 'ORIGIN', title: `ORIGIN ${id} · ${P(ev.conf)} · ±${mtr(ev.radius)}`, since: evs[0].t,
    meta: `peak ${xy(ev)} · ${upto} update${upto === 1 ? '' : 's'} by ${T(at)}`,
    steps: [
      { role: 'OUTPUT', module: MOD.origin, t: ev.t, title: `ORIGIN ${id} · ${P(ev.conf)} · ±${mtr(ev.radius)}`, text: `Launch area estimated at ${xy(ev)}. First appeared ${T(evs[0].t)}; an estimate needs ${MIN_POINTS} fixes and settles at ${FIT_POINTS}.`, rows },
      {
        role: 'COMPUTED BY', module: MOD.origin, t: ev.t,
        title: `Back-projection from ${nFix} fixes ${window} of track ${id}`,
        text: `Fits a velocity to the earliest ${FIT_POINTS} fixes and steps back from the first one. Radius = 150 m + mean ellipse size; confidence rises with fix count and falls as the radius grows.`,
      },
      ...trackSteps(c, tr, 'DERIVED FROM'),
    ],
    uses,
  };
}

function teamInsp(c: Ctx, id: string): Insp | null {
  const { D, at } = c;
  const rec = D.teams.find((x) => x.id === id);
  if (!rec) return null;
  const lt = c.fr?.launch_teams.find((x) => x.id === id) ?? rec.final;
  const moves = rec.moves.filter((m) => m.t <= at);
  const relocs = moves.filter((m) => m.kind === 'reloc').length;
  const rows: Row[] = moves.map((m) => ({
    a: `${T(m.t)} ${m.trackId ?? ''}`.trim(),
    b: m.kind === 'found' ? `site founded at ${xy(m)}` : `${m.kind === 'reloc' ? 'relocation' : 'same site'} ${km(m.d)} from previous`,
    t: m.t,
    pick: m.trackId ? ({ k: 'origin', id: m.trackId } as Sel) : undefined,
  }));
  const members = lt.track_ids.filter((tid) => D.origins.get(tid)?.some((e) => e.t <= at));
  const memberRows: Row[] = members.map((tid) => {
    const evs = D.origins.get(tid)!;
    const ev = evs[countUpTo(evs, at) - 1];
    return { a: `${tid}`, b: `${P(ev.conf)} ±${mtr(ev.radius)} at ${xy(ev)}`, pick: { k: 'origin', id: tid } as Sel };
  });
  const uses: Use[] = [{ text: `drives the next-launch forecast (${MOD.forecast})`, pick: { k: 'forecast' } }];
  uses.push(...alertUses(c, (a) => a.ref_id === id));
  if (D.sites.some((s) => s.team_id === id && s.first_seen_t <= at)) uses.push({ text: `site pinned by survey (${MOD.fusion})`, pick: { k: 'site', id } });
  const tr0 = members.length ? D.trackById.get(members[0]) : undefined;
  return {
    chip: 'TEAM', title: `LAUNCH TEAM ${id}`, since: rec.first,
    meta: `${moves.length} launch${moves.length === 1 ? '' : 'es'} · ${relocs} relocation${relocs === 1 ? '' : 's'} by ${T(at)}`,
    steps: [
      { role: 'OUTPUT', module: MOD.teams, title: `${id} · ${moves.length} launch${moves.length === 1 ? '' : 'es'} · ${relocs} relocation${relocs === 1 ? '' : 's'}`, text: `Tracks ${lt.track_ids.join(', ') || 'none'}. Each row is the origin of one track, when its estimate first appeared.`, rows },
      {
        role: 'COMPUTED BY', module: MOD.teams, title: 'Origin linking rules',
        text: `Each track is assigned once. Within ${mtr(JOIN_M)} of a team's latest origin: same site. Within ${mtr(MOVE_M)} and more than ${MOVE_AFTER_S} s after its last launch: relocation. Otherwise a new team.`,
      },
      { role: 'DERIVED FROM', module: MOD.origin, title: `ORIGIN ESTIMATES · ${members.length}`, text: 'One back-projected launch point per member track.', rows: memberRows },
      ...(tr0 ? trackSteps(c, tr0, 'DERIVED FROM').slice(0, 1) : []),
    ],
    uses,
  };
}

function forecastInsp(c: Ctx): Insp | null {
  const { D, at } = c;
  const f = D.fc;
  if (f.first < 0) return null;
  const s = f.has[at] ? at : (() => { let i = at; while (i > 0 && !f.has[i]) i--; return f.has[i] ? i : f.first; })();
  const teams = c.fr?.launch_teams ?? [];
  const teamRows: Row[] = teams.map((lt) => {
    const h = lt.origin_history;
    if (!h.length) return { a: lt.id, b: 'no origins yet' };
    const last = h[h.length - 1];
    const dx = h.length > 1 ? (last.x - h[0].x) / (h.length - 1) : 0, dy = h.length > 1 ? (last.y - h[0].y) / (h.length - 1) : 0;
    const sigma = Math.min(SIGMA0_M + SIGMA_GROWTH * Math.max(0, at - last.t), SIGMA_MAX_M);
    return { a: lt.id, b: `centre ${xy({ x: last.x + dx, y: last.y + dy })} · spread ±${mtr(sigma)}`, pick: { k: 'team', id: lt.id } as Sel };
  });
  const moveRows: Row[] = D.fc.moves.filter((m) => m.t <= at).slice(-5).map((m) => ({ a: T(m.t), b: `peak at ${xy(m)}`, t: m.t }));
  const tids = [...new Set(teams.flatMap((lt) => lt.track_ids))].filter((tid) => D.origins.get(tid)?.some((e) => e.t <= at));
  const confirmed = D.sites.filter((x) => x.first_seen_t <= at);
  return {
    chip: 'FORECAST', title: `FORECAST HEAT · peak ${f.peak[s].toFixed(2)}`, since: f.first,
    meta: `peak at ${xy({ x: f.x[s], y: f.y[s] })} · hot area ${f.spread[s].toFixed(2)} km2 · ${T(s)}`,
    steps: [
      { role: 'OUTPUT', module: MOD.forecast, t: s, title: `Next-launch heat map, peak ${f.peak[s].toFixed(2)} at ${xy({ x: f.x[s], y: f.y[s] })}`, text: `Hot area (cells above half the peak) ${f.spread[s].toFixed(2)} km2. The peak has moved ${Math.max(0, D.fc.moves.filter((m) => m.t <= at).length - 1)} time(s) so far.`, rows: moveRows },
      {
        role: 'COMPUTED BY', module: MOD.forecast, title: 'One blob per launch team, summed and normalised',
        text: `Centre is the team's last origin plus the mean step between its origins, so a team that keeps relocating is expected to relocate again. The blob widens ${SIGMA_GROWTH} m per quiet second from ${mtr(SIGMA0_M)} to at most ${mtr(SIGMA_MAX_M)}.${confirmed.length ? ' A surveyed site re-centres its blob.' : ''}`,
        rows: teamRows,
      },
      { role: 'DERIVED FROM', module: MOD.teams, title: `LAUNCH TEAMS · ${teams.length}`, text: 'Origin history of each team (see launch teams lane).', rows: teams.map((lt) => ({ a: lt.id, b: `${lt.origin_history.length} origin${lt.origin_history.length === 1 ? '' : 's'}`, pick: { k: 'team', id: lt.id } as Sel })) },
      { role: 'DERIVED FROM', module: MOD.origin, title: `ORIGIN ESTIMATES · ${tids.length}`, text: `From tracks ${tids.join(', ') || 'none yet'}, each built from tracker fixes and simulated detections.` },
    ],
    uses: [
      { text: 'drawn as the forecast heat layer on the map' },
      ...alertUses(c, (a) => a.kind === 'launch_team_moved' || a.kind === 'launch_forecast'),
    ],
  };
}

function routeInsp(c: Ctx, id: string): Insp | null {
  const first = c.D.routeFirst.get(id);
  if (first === undefined) return null;
  const r = c.fr?.routes.find((x) => x.id === id);
  if (!r) return null;
  return {
    chip: 'ROUTE', title: `FRIENDLY ROUTE ${id} · risk ${P(r.risk)}`, since: first,
    meta: `${r.risk_level} risk · exposed by ${r.exposed_by.join(', ') || 'no sensor'}`,
    steps: [
      { role: 'OUTPUT', module: MOD.exposure, title: `ROUTE ${id} · ${r.risk_level} · ${P(r.risk)}`, text: `${r.safer_waypoints ? 'A safer corridor was computed.' : 'No safer corridor found.'} Risk scores how much of the route's contested end sits inside enemy sensor coverage.` },
      {
        role: 'DERIVED FROM', module: MOD.sim, title: `ENEMY SENSORS · ${r.exposed_by.length}`, text: 'Coverage range and position of each sensor that sees the route.',
        rows: r.exposed_by.map((sid) => ({ a: sid, b: `${c.D.sensorById.get(sid)?.type ?? 'sensor'}`, pick: c.D.sensorById.has(sid) ? ({ k: 'sensor', id: sid } as Sel) : undefined })),
      },
    ],
    uses: alertUses(c, (a) => a.ref_id === id),
  };
}

function reconInsp(c: Ctx): Insp | null {
  const { D, at } = c;
  const rr = D.reconRoute;
  const id = rr?.id ?? D.spans[0]?.routeId;
  if (!id) return null;
  const state = c.fr?.recon;
  const since = D.spans.length ? D.spans[0].t0 : (rr?.log[0]?.t ?? 0);
  const status = state?.status ?? D.spans.filter((s) => s.t0 <= at).pop()?.status ?? 'proposed';
  const log: Row[] = (rr?.log ?? []).filter((l) => l.t <= at).map((l) => ({ a: T(l.t), b: `${l.event}${l.by ? ` by ${l.by}` : ''}`, t: l.t }));
  return {
    chip: 'SURVEY', title: `SURVEY FLIGHT ${id}`, since,
    meta: `${status}${state ? ` · risk now ${P(state.risk_now)}` : ''}${rr ? ` · info gain ${P(rr.info_gain)} · planned risk ${P(rr.risk)}` : ''}`,
    steps: [
      { role: 'OUTPUT', module: MOD.recon, title: `Recon ${id} · ${status}${rr ? ` · ${rr.approved_by ? `approved by ${rr.approved_by}` : 'awaiting operator approval'}` : ''}`, text: 'Nothing flies unless a named operator approved the route. It stays inside a geofence and returns home when risk passes 60%.', rows: log },
      { role: 'DERIVED FROM', module: MOD.exposure, title: 'Exposure grid', text: 'The planner never enters cells with exposure above 45%, so the route trades information against being seen.' },
      { role: 'DERIVED FROM', module: MOD.recon, title: 'Launch-area value map', text: 'Information gain is the share of that map the route can observe.' },
    ],
    uses: [...alertUses(c, (a) => a.kind === 'recon_auto_return' || a.kind === 'launch_site_confirmed')],
  };
}

function siteInsp(c: Ctx, teamId: string): Insp | null {
  const s = c.D.sites.find((x) => x.team_id === teamId);
  if (!s) return null;
  return {
    chip: 'SITE', title: `CONFIRMED SITE ${teamId} · ±${mtr(s.radius_m)}`, since: s.first_seen_t,
    meta: `${xy(s)} · seen ${T(s.first_seen_t)}..${T(s.last_seen_t)} by ${s.source}`,
    steps: [
      { role: 'OUTPUT', module: MOD.fusion, t: s.first_seen_t, title: `Launch site ${teamId} pinned at ${xy(s)}`, text: 'An origin estimate within 900 m of the sighting snaps to the pinpoint. Stays at the last known position.' },
      { role: 'DERIVED FROM', module: MOD.recon, t: s.first_seen_t, title: `Survey sighting by ${s.source}`, text: 'A launch site within 1,500 m of the survey drone is pinpointed. A sighting exists only after an operator approved the flight.' },
      { role: 'DERIVED FROM', module: MOD.teams, title: `Launch team ${teamId}`, pick: { k: 'team', id: teamId } },
    ],
    uses: [{ text: `re-centres the forecast blob (${MOD.forecast})`, pick: { k: 'forecast' } }, ...alertUses(c, (a) => a.kind === 'launch_site_confirmed' && a.ref_id === teamId)],
  };
}

function alertInsp(c: Ctx, i: number): Insp | null {
  const a = c.D.alerts[i];
  if (!a) return null;
  const rule = ALERT_RULE[a.kind] ?? { module: MOD.alerts, rule: 'Event rule.' };
  const sub = inspectSel({ D: c.D, at: a.t, fr: c.D.frameAt(a.t) }, subjectOf(a)); // the subject as it stood when the alert fired
  return {
    chip: 'ALERT', title: `ALERT ${kindLabel(a.kind)} · ${T(a.t)}`, since: a.t, meta: `subject ${a.ref_id}`,
    steps: [
      { role: 'OUTPUT', module: rule.module, t: a.t, title: a.message, text: `Recommended: ${a.recommended_action}` },
      { role: 'COMPUTED BY', module: rule.module, title: `Rule: ${kindLabel(a.kind)}`, text: rule.rule },
      ...(sub ? sub.steps.map((s, k) => (k === 0 ? { ...s, role: 'SUBJECT' } : s)) : []),
    ],
    uses: sub ? sub.uses.filter((u) => !(u.pick?.k === 'alert' && u.pick.i === i)) : [],
  };
}

function inspectSel(c: Ctx, sel: Sel): Insp | null {
  switch (sel.k) {
    case 'sensor': return sensorInsp(c, sel.id);
    case 'track': return trackInsp(c, sel.id);
    case 'origin': return originInsp(c, sel.id);
    case 'team': return teamInsp(c, sel.id);
    case 'forecast': return forecastInsp(c);
    case 'alert': return alertInsp(c, sel.i);
    case 'route': return routeInsp(c, sel.id);
    case 'recon': return reconInsp(c);
    case 'site': return siteInsp(c, sel.id);
  }
}

/* ---------- alert groups (same four colours as the bottom timeline) ---------- */
type Group = 'risk' | 'origin' | 'site' | 'track';
const GROUPS: Group[] = ['risk', 'origin', 'site', 'track'];
const GROUP_OF: Record<AlertKind, Group> = {
  route_exposed: 'risk', recon_auto_return: 'risk', origin_confident: 'origin', launch_team_moved: 'origin', launch_forecast: 'origin',
  launch_site_confirmed: 'site', new_track: 'track', track_lost: 'track',
};

const STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300];
const tickStep = (max: number) => STEPS.find((s) => max / s <= 8) ?? 600;

/* ---------- view ---------- */
export default function ProvenanceView({ scenario, t, onJump, onSelectTrack }: Props) {
  const D = useMemo(() => derive(scenario), [scenario]);
  const [pin, setPin] = useState<{ sc: Scenario; sel: Sel } | null>(null);
  const cur = clamp(Math.round(t), 0, D.end);
  const { n, end } = D;
  const pinned = pin && pin.sc === scenario ? pin.sel : null;

  const nAlerts = countUpTo(D.alerts, cur);
  const sel: Sel | null = pinned
    ?? (nAlerts > 0 ? subjectOf(D.alerts[nAlerts - 1]) : D.tracks.find((tr) => tr.first <= cur) ? { k: 'track', id: D.tracks.find((tr) => tr.first <= cur)!.id } : null);
  const selKey = sel ? JSON.stringify(sel) : '';

  const insp = useMemo(() => {
    if (!sel) return null;
    const probe = inspectSel({ D, at: cur, fr: D.frameAt(cur) }, sel);
    if (!probe) return null;
    const at = Math.max(cur, probe.since);
    return at === cur ? probe : inspectSel({ D, at, fr: D.frameAt(at) }, sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selKey stands in for sel
  }, [D, selKey, cur]);

  const pick = (s: Sel) => {
    setPin({ sc: scenario, sel: s });
    if (s.k === 'track' || s.k === 'origin') onSelectTrack(s.id);
  };

  const pos = (s: number) => `${((s + 0.5) / n) * 100}%`;
  const flip = (s: number) => (s / n > 0.86 ? ' flip' : ''); // labels near the right edge open leftwards
  const seek = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    onJump(clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, end));
  };
  const mark = (e: MouseEvent, s: Sel, at: number) => { e.stopPropagation(); pick(s); onJump(at); };

  const step = tickStep(end);
  const ticks = Array.from({ length: Math.floor(end / step) + 1 }, (_, i) => i * step);

  const shownTracks = D.tracks.slice(0, MAX_TRACK_ROWS);
  const originRows = shownTracks.filter((tr) => D.origins.has(tr.id));
  const nTracks = D.tracks.filter((tr) => tr.first <= cur).length;
  const nOrigin = [...D.origins.values()].filter((evs) => evs[0].t <= cur).length;
  const nMoves = D.teams.reduce((a, tm) => a + tm.moves.filter((m) => m.kind === 'reloc' && m.t <= cur).length, 0);
  const nDet = D.detCum[cur + 1] - D.clutCum[cur + 1];
  const nClutter = D.clutCum[cur + 1];

  const selIs = (s: Sel) => selKey === JSON.stringify(s);
  const fut = `${((cur + 1) / n) * 100}%`;
  const clipStyle = { clipPath: `inset(0 ${100 - ((cur + 1) / n) * 100}% 0 0)` };

  const fcPaths = useMemo(() => {
    const h = 40, f = D.fc;
    const line = (arr: Float32Array, max: number) => {
      let d = '', pen = false;
      for (let i = 0; i < n; i++) {
        if (!f.has[i]) { pen = false; continue; }
        const y = h - 3 - (max > 0 ? arr[i] / max : 0) * (h - 6);
        d += `${pen ? 'L' : 'M'}${i + 0.5} ${y.toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    return { peak: line(f.peak, f.peakMax), spread: line(f.spread, f.spreadMax), h };
  }, [D, n]);

  const reconLog = scenario.recon_route?.log ?? [];
  const noSurvey = D.spans.length === 0 && D.sites.length === 0 && reconLog.length === 0;

  return (
    <section className="pv" aria-label="Provenance: data lineage">
      <header className="pv-head">
        <div className="pv-title">
          <h2>PROVENANCE // DATA LINEAGE</h2>
          <p>All data simulated. Model outputs are estimates.</p>
        </div>
        <dl className="pv-stats">
          {([
            ['Detections', nDet], ['Clutter rejected', nClutter], ['Tracks', nTracks],
            ['Origin estimates', nOrigin], ['Team moves', nMoves], ['Alerts', nAlerts],
          ] as [string, number][]).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
          <div className="pv-now"><dt>Time</dt><dd>{T(cur)}<small> / {pad3(end)}</small></dd></div>
        </dl>
      </header>

      <div className="pv-scroll">
        <div className="pv-lanes">
          {/* shared axis */}
          <div className="pv-row pv-ruler">
            <div className="pv-lab"><span>Seconds</span></div>
            <div className="pv-plot" onClick={seek}>
              {ticks.map((s) => <span key={s} className="pv-tick" style={{ left: pos(s) }}><em>{pad3(s)}</em></span>)}
              <span className="pv-curtag" style={{ left: pos(cur) }}>{pad3(cur)}</span>
            </div>
          </div>

          <h3 className="pv-lane-h">Sensors <small>detections per second, clutter greyed · {MOD.sim}</small></h3>
          {D.sensors.slice(0, MAX_SENSOR_ROWS).map((s) => (
            <div key={s.id} className={`pv-row pv-side-${s.side}`}>
              <button className={`pv-lab pv-lab-btn${selIs({ k: 'sensor', id: s.id }) ? ' on' : ''}`} onClick={() => pick({ k: 'sensor', id: s.id })}>
                <i className="pv-dot" /><span>{s.id} {TYPE_CODE[s.type] ?? s.type}</span><b>{s.cumReal[cur + 1]}</b>
              </button>
              <div className="pv-plot" onClick={seek}>
                <svg className="pv-ticks" viewBox={`0 0 ${n} 20`} preserveAspectRatio="none" style={clipStyle} aria-hidden="true">
                  <path className="pv-t-real" d={s.pathReal} />
                  <path className="pv-t-clutter" d={s.pathClutter} />
                </svg>
              </div>
            </div>
          ))}

          <h3 className="pv-lane-h">Tracks <small>first to last fix, red = active, grey line = lost · {MOD.tracker}</small></h3>
          {shownTracks.map((tr) => {
            const segs = tr.runs.map((r, j) => {
              const a = Math.max(r.t, tr.first);
              const b = Math.min(tr.runs[j + 1] ? tr.runs[j + 1].t - 1 : tr.present1, cur);
              return { status: r.status, a, b };
            }).filter((g) => g.a <= cur && g.b >= g.a);
            const cap = segs.length ? segs[0] : null;
            return (
              <div key={tr.id} className="pv-row">
                <button className={`pv-lab pv-lab-btn${selIs({ k: 'track', id: tr.id }) ? ' on' : ''}`} onClick={() => pick({ k: 'track', id: tr.id })}>
                  <span>{tr.id}</span><b>{countUpTo(tr.points, cur)}</b>
                </button>
                <div className="pv-plot" onClick={seek}>
                  {segs.map((g, j) => (
                    <button
                      key={j}
                      className={`pv-bar ${g.status}`}
                      style={{ left: `${(g.a / n) * 100}%`, width: `${((g.b - g.a + 1) / n) * 100}%` }}
                      onClick={() => pick({ k: 'track', id: tr.id })}
                      title={`${tr.id} ${g.status} ${T(g.a)}..${T(g.b)}`}
                    >
                      {g === cap ? tr.id : ''}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {D.tracks.length > MAX_TRACK_ROWS && <p className="pv-more">+{D.tracks.length - MAX_TRACK_ROWS} more tracks not drawn</p>}
          {D.tracks.length === 0 && <p className="pv-empty">No tracks in this run.</p>}

          <h3 className="pv-lane-h">Origin estimates <small>marker per confidence change · {MOD.origin}</small></h3>
          {originRows.map((tr) => {
            const evs = D.origins.get(tr.id)!;
            const vis = evs.slice(0, countUpTo(evs, cur));
            const keep = vis.length > 10 ? vis.filter((_, j) => j === 0 || j === vis.length - 1 || j % Math.ceil(vis.length / 8) === 0) : vis;
            const firstEv = vis[0], lastEv = vis[vis.length - 1];
            return (
              <div key={tr.id} className="pv-row">
                <button className={`pv-lab pv-lab-btn${selIs({ k: 'origin', id: tr.id }) ? ' on' : ''}`} onClick={() => pick({ k: 'origin', id: tr.id })}>
                  <span>{tr.id}</span><b>{lastEv ? P(lastEv.conf) : ''}</b>
                </button>
                <div className="pv-plot" onClick={seek}>
                  {vis.length > 1 && <i className="pv-span pv-origin" style={{ left: pos(firstEv.t), width: `${((lastEv.t - firstEv.t) / n) * 100}%` }} />}
                  {keep.map((ev) => (
                    <button
                      key={ev.t}
                      className={`pv-mk pv-origin${ev.conf >= CONFIDENT_AT ? ' solid' : ''}${ev === firstEv ? ' big' : ''}`}
                      style={{ left: pos(ev.t) }}
                      onClick={(e) => mark(e, { k: 'origin', id: tr.id }, ev.t)}
                      title={`Origin ${tr.id} ${T(ev.t)} ${P(ev.conf)} ±${mtr(ev.radius)}`}
                    />
                  ))}
                  {firstEv && <span className={`pv-pct${flip(firstEv.t)}`} style={{ left: pos(firstEv.t) }}>{P(firstEv.conf)}</span>}
                  {lastEv && lastEv !== firstEv && lastEv.t - firstEv.t >= 7 && <span className={`pv-pct${flip(lastEv.t)}`} style={{ left: pos(lastEv.t) }}>{P(lastEv.conf)}</span>}
                </div>
              </div>
            );
          })}
          {originRows.length === 0 && <p className="pv-empty">No origin estimates in this run.</p>}

          <h3 className="pv-lane-h">Launch teams <small>team span, marker per origin, amber = relocation · {MOD.teams}</small></h3>
          {D.teams.map((tm) => (
            <div key={tm.id} className="pv-row">
              <button className={`pv-lab pv-lab-btn${selIs({ k: 'team', id: tm.id }) ? ' on' : ''}`} onClick={() => pick({ k: 'team', id: tm.id })}>
                <span>{tm.id}</span><b>{tm.moves.filter((m) => m.t <= cur).length}</b>
              </button>
              <div className="pv-plot" onClick={seek}>
                {tm.first <= cur && <i className="pv-span pv-team" style={{ left: pos(tm.first), width: `${((cur - tm.first) / n) * 100}%` }} />}
                {tm.moves.filter((m) => m.t <= cur).map((m) => (
                  <button
                    key={m.i}
                    className={`pv-mk pv-team-mk ${m.kind}`}
                    style={{ left: pos(m.t) }}
                    onClick={(e) => mark(e, { k: 'team', id: tm.id }, m.t)}
                    title={m.kind === 'found' ? `${tm.id} founded ${T(m.t)}` : `${tm.id} ${m.kind === 'reloc' ? 'relocated' : 'same site'} ${km(m.d)} ${T(m.t)}`}
                  />
                ))}
                {tm.moves.filter((m) => m.t <= cur && m.kind === 'reloc').map((m) => (
                  <span key={m.i} className={`pv-pct${flip(m.t)}`} style={{ left: pos(m.t) }}>+{km(m.d)}</span>
                ))}
              </div>
            </div>
          ))}
          {D.teams.length === 0 && <p className="pv-empty">No launch teams in this run.</p>}

          <h3 className="pv-lane-h">Forecasts <small>heat peak (solid) and hot area (dim) over time · {MOD.forecast}</small></h3>
          <div className="pv-row pv-fc">
            <button className={`pv-lab pv-lab-btn${selIs({ k: 'forecast' }) ? ' on' : ''}`} onClick={() => pick({ k: 'forecast' })}>
              <span className="pv-lab-2"><span>Peak<b>{D.fc.has[cur] ? D.fc.peak[cur].toFixed(2) : ''}</b></span><span>Area<b>{D.fc.has[cur] ? `${D.fc.spread[cur].toFixed(1)} km2` : ''}</b></span></span>
            </button>
            <div className="pv-plot" onClick={seek}>
              {D.fc.first >= 0 ? (
                <>
                  <svg className="pv-spark" viewBox={`0 0 ${n} ${fcPaths.h}`} preserveAspectRatio="none" style={clipStyle} aria-hidden="true">
                    <path className="pv-spread" d={fcPaths.spread} vectorEffect="non-scaling-stroke" />
                    <path className="pv-peak" d={fcPaths.peak} vectorEffect="non-scaling-stroke" />
                  </svg>
                  {D.fc.moves.filter((m) => m.t <= cur).map((m, j) => (
                    <button
                      key={m.t}
                      className="pv-mk pv-fc-mk"
                      style={{ left: pos(m.t), top: `${(1 - 3 / fcPaths.h - (D.fc.peakMax > 0 ? D.fc.peak[m.t] / D.fc.peakMax : 0) * (1 - 6 / fcPaths.h)) * 100}%` }}
                      onClick={(e) => mark(e, { k: 'forecast' }, m.t)}
                      title={`${j === 0 ? 'Forecast starts' : 'Forecast peak moved'} ${T(m.t)} to ${xy(m)}`}
                    />
                  ))}
                </>
              ) : <span className="pv-none">No forecast in this run</span>}
            </div>
          </div>

          <h3 className="pv-lane-h">Alerts <small>by kind group · {MOD.alerts}</small></h3>
          <div className="pv-alerts">
            <div className="pv-alab">{GROUPS.map((g) => <span key={g} className={`pv-g g-${g}`}>{g}</span>)}</div>
            <div className="pv-plot" onClick={seek}>
              {D.alerts.slice(0, nAlerts).map((a, i) => (
                <button
                  key={i}
                  className={`pv-mk pv-alert g-${GROUP_OF[a.kind] ?? 'track'}${selIs({ k: 'alert', i }) ? ' on' : ''}`}
                  style={{ left: pos(a.t), top: `${GROUPS.indexOf(GROUP_OF[a.kind] ?? 'track') * 25 + 12.5}%` }}
                  onClick={(e) => mark(e, { k: 'alert', i }, a.t)}
                  title={`${T(a.t)} ${kindLabel(a.kind)}: ${a.message}`}
                />
              ))}
            </div>
          </div>

          <h3 className="pv-lane-h">Survey and confirmations <small>recon flight spans, confirmed sites · {MOD.recon}, {MOD.fusion}</small></h3>
          <div className="pv-row">
            <button className={`pv-lab pv-lab-btn${selIs({ k: 'recon' }) ? ' on' : ''}`} onClick={() => pick({ k: 'recon' })}>
              <span>Recon</span><b>{D.spans.length || ''}</b>
            </button>
            <div className="pv-plot" onClick={seek}>
              {D.spans.filter((s) => s.t0 <= cur).map((s, j) => (
                <button
                  key={j}
                  className={`pv-bar recon ${s.status}`}
                  style={{ left: `${(s.t0 / n) * 100}%`, width: `${((Math.min(s.t1, cur) - s.t0 + 1) / n) * 100}%` }}
                  onClick={() => pick({ k: 'recon' })}
                  title={`${s.routeId} ${s.status} ${T(s.t0)}..${T(s.t1)}`}
                >{s.status}</button>
              ))}
              {reconLog.filter((l) => l.t <= cur).map((l, j) => (
                <button key={`l${j}`} className="pv-mk pv-log" style={{ left: pos(l.t) }} onClick={(e) => mark(e, { k: 'recon' }, l.t)} title={`${T(l.t)} ${l.event}${l.by ? ` by ${l.by}` : ''}`} />
              ))}
              {D.sites.filter((s) => s.first_seen_t <= cur).map((s) => (
                <button key={s.team_id} className="pv-mk pv-site" style={{ left: pos(s.first_seen_t) }} onClick={(e) => mark(e, { k: 'site', id: s.team_id }, s.first_seen_t)} title={`Site ${s.team_id} confirmed ${T(s.first_seen_t)}`} />
              ))}
              {D.sites.filter((s) => s.first_seen_t <= cur).map((s) => (
                <span key={`t${s.team_id}`} className={`pv-pct ok${flip(s.first_seen_t)}`} style={{ left: pos(s.first_seen_t) }}>{s.team_id}</span>
              ))}
              {noSurvey && <span className="pv-none">No survey flown in this run</span>}
            </div>
          </div>

          {/* cursor, grid and the not-yet-computed future, over every plot column */}
          <div className="pv-overlay" aria-hidden="true">
            {ticks.map((s) => <i key={s} className="pv-grid" style={{ left: pos(s) }} />)}
            <div className="pv-future" style={{ left: fut }} />
            <div className="pv-cursor" style={{ left: pos(cur) }} />
          </div>
        </div>
      </div>

      <aside className="pv-insp" aria-label="Object inspector">
        <div className="pv-insp-bar">
          <span>Object inspector</span>
          {pinned && <button onClick={() => setPin(null)} title="Return to the subject of the latest alert">Follow latest alert</button>}
        </div>
        {!insp && <p className="pv-empty">Select a sensor, track, estimate, team, forecast or alert to see where it came from.</p>}
        {insp && (
          <div className="pv-insp-body">
            <div className="pv-subject">
              <span className="pv-chip">{insp.chip}</span>
              <h3>{insp.title}</h3>
              <p>{insp.meta}</p>
              {insp.since > cur && (
                <p className="pv-future-note">
                  Not produced yet at {T(cur)}. Shown as of {T(insp.since)}.
                  <button onClick={() => onJump(insp.since)}>Jump to {T(insp.since)}</button>
                </p>
              )}
            </div>

            <h4>Lineage</h4>
            <ol className="pv-chain">
              {insp.steps.map((s, i) => (
                <li key={i} className={`pv-step${i === 0 ? ' out' : ''}`}>
                  <i className="pv-node" />
                  <div className="pv-step-body">
                    <div className="pv-step-head"><span>{s.role}</span><code>{s.module}</code></div>
                    {s.pick || s.t !== undefined ? (
                      <button className="pv-step-title" onClick={() => { if (s.pick) pick(s.pick); if (s.t !== undefined) onJump(s.t); }}>{s.title}</button>
                    ) : <div className="pv-step-title">{s.title}</div>}
                    {s.text && <p>{s.text}</p>}
                    {s.rows && s.rows.length > 0 && (
                      <ul className="pv-rows">
                        {s.rows.map((r, j) => (
                          <li key={j}>
                            {r.t !== undefined || r.pick ? (
                              <button onClick={() => { if (r.pick) pick(r.pick); if (r.t !== undefined) onJump(r.t); }}><b>{r.a}</b>{r.b && <span>{r.b}</span>}</button>
                            ) : <div><b>{r.a}</b>{r.b && <span>{r.b}</span>}</div>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <h4>Downstream uses</h4>
            {insp.uses.length === 0 && <p className="pv-empty">Nothing consumes this yet.</p>}
            <ul className="pv-uses">
              {insp.uses.map((u, i) => (
                <li key={i}>
                  {u.pick || u.t !== undefined ? (
                    <button onClick={() => { if (u.pick) pick(u.pick); if (u.t !== undefined) onJump(u.t); }}>{u.t !== undefined && <b>{T(u.t)}</b>}{u.text}</button>
                  ) : <div>{u.text}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </section>
  );
}
