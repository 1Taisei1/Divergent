// Local previews used only when no VITE_API_URL is set, so the UI can be built and demoed from the fixture.
// They imitate the API's shapes; the real logic lives in Diego's api/ and Ali's planning/ modules.
import type { ConfirmedSite, Point, ReconLogEntry, ReconRoute, ReconState, Scenario, WhatIfRequest } from './types';

const clone = <T,>(v: T): T => structuredClone(v);

export function explainOffline(s: Scenario, t: number): string {
  const f = s.frames[Math.min(t, s.frames.length - 1)];
  if (!f) return 'No data at this time.';
  const top = [...f.origins].sort((a, b) => b.confidence - a.confidence)[0];
  const l1 = top
    ? `Best origin estimate: ${top.track_id} launched near (${Math.round(top.peak.x)}, ${Math.round(top.peak.y)}) m, confidence ${Math.round(top.confidence * 100)}%.`
    : `${f.tracks.length} active tracks; no origin estimate yet.`;
  const risky = f.routes.filter((r) => r.risk_level === 'high').map((r) => r.id);
  const l2 = risky.length ? `High-risk friendly routes: ${risky.join(', ')}; a safer corridor is available.` : 'No friendly route is at high risk.';
  return `${l1}\n${l2}\nRecommendation only; an operator decides. (Local preview, simulated data.)`;
}

export function whatIfOffline(s: Scenario, req: WhatIfRequest): Scenario {
  const out = clone(s);
  const sensor = out.sensors.find((x) => x.id === req.sensor_id);
  if (!sensor) throw new Error(`Unknown sensor ${req.sensor_id}`);
  if (req.action === 'disable') sensor.active = false;
  else {
    sensor.x = req.x ?? sensor.x;
    sensor.y = req.y ?? sensor.y;
  }
  const keep = (d: { sensor_id: string; x: number; y: number }) =>
    d.sensor_id !== sensor.id || (sensor.active && Math.hypot(d.x - sensor.x, d.y - sensor.y) <= sensor.range_m);
  for (const f of out.frames) {
    f.detections = f.detections.filter(keep);
    if (!sensor.active) for (const tr of f.tracks) tr.sensor_ids = tr.sensor_ids.filter((id) => id !== sensor.id);
  }
  out.name = `${s.name} (local what-if preview)`;
  return out;
}

const lerp = (a: Point, b: Point, k: number): Point => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });

function along(path: Point[], d: number): Point {
  for (let i = 1; i < path.length; i++) {
    const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (d <= seg) return lerp(path[i - 1], path[i], seg ? d / seg : 1);
    d -= seg;
  }
  return path[path.length - 1];
}
const length = (path: Point[]) =>
  path.slice(1).reduce((acc, p, i) => acc + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

// Fly the route from t0 to the end of the scenario; return home in a straight line from abortT if given.
function fly(s: Scenario, route: ReconRoute, t0: number, abortT: number | null): Scenario {
  const out = clone(s);
  const g = route.geofence;
  const clamp = (p: Point): Point => ({
    x: Math.min(g.x_max, Math.max(g.x_min, p.x)), y: Math.min(g.y_max, Math.max(g.y_min, p.y)) });
  const home = route.waypoints[route.waypoints.length - 1];
  const last = out.frames.length - 1;
  // The fixture is short, so the preview speed fits the whole sweep into the remaining frames.
  const speed = length(route.waypoints) / Math.max(1, last - t0);
  const log: ReconLogEntry[] = [...route.log];
  let returnFrom: Point | null = null;
  let returnT = 0;
  let status: ReconState['status'] = 'flying';
  log.push({ t: t0, event: 'flying' });
  const seen = new Map<string, ConfirmedSite>();
  for (const f of out.frames) {
    f.confirmed_sites = [];
    if (f.t < t0) { f.recon = null; continue; }
    if (abortT !== null && f.t >= abortT && !returnFrom) {
      const prev = out.frames[f.t - 1]?.recon;
      returnFrom = prev ? { x: prev.x, y: prev.y } : along(route.waypoints, 0);
      returnT = f.t;
      status = 'aborted';
      log.push({ t: f.t, event: 'aborted' });
    }
    let p: Point;
    if (returnFrom) {
      const dist = Math.hypot(home.x - returnFrom.x, home.y - returnFrom.y);
      const k = Math.min(1, ((f.t - returnT) * Math.max(speed, 200)) / Math.max(1, dist));
      p = lerp(returnFrom, home, k);
      if (k >= 1 && status !== 'returned') { status = 'returned'; log.push({ t: f.t, event: 'returned' }); }
    } else {
      const d = (f.t - t0) * speed;
      p = along(route.waypoints, d);
      if (d >= length(route.waypoints) && status !== 'returned') { status = 'returned'; log.push({ t: f.t, event: 'returned' }); }
    }
    p = clamp(p);
    f.recon = { route_id: route.id, x: Math.round(p.x), y: Math.round(p.y), status, risk_now: route.risk };
    for (const lt of f.launch_teams) {
      const site = lt.origin_history[lt.origin_history.length - 1];
      if (!site || Math.hypot(site.x - p.x, site.y - p.y) > 1000) continue;
      const prev = seen.get(lt.id);
      seen.set(lt.id, { team_id: lt.id, x: site.x, y: site.y, radius_m: 60, first_seen_t: prev?.first_seen_t ?? f.t, last_seen_t: f.t, source: route.id });
      if (!prev) f.alerts = [...f.alerts, { t: f.t, kind: 'launch_site_confirmed', ref_id: lt.id,
        message: `Survey ${route.id} pinpointed the launch site of ${lt.id} at (${Math.round(site.x)}, ${Math.round(site.y)}) ±60 m.`,
        recommended_action: 'Site confirmed; keep monitoring and report it.' }];
    }
    f.confirmed_sites = [...seen.values()].map((c) => ({ ...c }));
    for (const lt of f.launch_teams) if (seen.has(lt.id)) lt.confirmed = true;
  }
  out.recon_route = { ...route, status: abortT !== null ? 'aborted' : 'flying', log };
  return out;
}

export function reconApproveOffline(s: Scenario, route: ReconRoute, operator: string, t: number): Scenario {
  const approved: ReconRoute = { ...clone(route), status: 'approved', approved_by: operator, approved_at: t,
    log: [...route.log, { t, event: 'approved', by: operator }] };
  return fly(s, approved, t, null);
}

export function reconAbortOffline(s: Scenario, route: ReconRoute, t: number): Scenario {
  const t0 = typeof route.approved_at === 'number' ? route.approved_at : t;
  const base: ReconRoute = { ...clone(route), log: route.log.filter((e) => e.event === 'proposed' || e.event === 'approved') };
  return fly(s, base, t0, t);
}
