// Generates fixtures/scenario_demo.json: a small, valid Scenario (CONTRACT.md) for building the web UI offline.
// All data is synthetic. Fixed seed. Run: node fixtures/make_scenario_demo.mjs
import { writeFileSync } from 'node:fs';

const SEED = 42;
const N_FRAMES = 20;
// Grids are kept small (20 x 20 cells of 500 m) so the fixture stays light; the UI reads cell_m/width/height.
const CELL = 500;
const GN = 20;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const sensors = [
  { id: 'S1', side: 'allied', type: 'radar', x: 2500, y: 4000, range_m: 2500, active: true },
  { id: 'S2', side: 'allied', type: 'acoustic', x: 5200, y: 5200, range_m: 1500, active: true },
  { id: 'S3', side: 'allied', type: 'rf', x: 4200, y: 2400, range_m: 3000, active: true },
  { id: 'S4', side: 'allied', type: 'radar', x: 7200, y: 4200, range_m: 2500, active: true },
  { id: 'ES1', side: 'enemy', type: 'rf', x: 2000, y: 7000, range_m: 2000, active: true },
  { id: 'ES2', side: 'enemy', type: 'radar', x: 4000, y: 6000, range_m: 2000, active: true },
];
const SIGMA = { radar: 40, acoustic: 90, rf: 140 };
const allied = sensors.filter((s) => s.side === 'allied');

// Two drones from one launch team that relocated between launches.
const drones = [
  { id: 'E1', track: 'T1', launch_t: 1, from: { x: 1800, y: 3600 }, vx: 110, vy: 25 },
  { id: 'E2', track: 'T2', launch_t: 5, from: { x: 3000, y: 2200 }, vx: 120, vy: 45 },
];
const truthAt = (d, t) =>
  t < d.launch_t ? null : { x: d.from.x + d.vx * (t - d.launch_t), y: d.from.y + d.vy * (t - d.launch_t) };

function grid(fn) {
  const values = [];
  let max = 0;
  for (let row = 0; row < GN; row++) {
    const r = [];
    for (let col = 0; col < GN; col++) {
      const v = fn((col + 0.5) * CELL, (row + 0.5) * CELL);
      r.push(v);
      max = Math.max(max, v);
    }
    values.push(r);
  }
  // Normalize to max 1 and drop the faint tail so only a few cells are non-zero.
  const out = values.map((r) => r.map((v) => (max > 0 && v / max >= 0.08 ? r2(v / max) : 0)));
  return { cell_m: CELL, width: GN, height: GN, values: out };
}
const gaussAt = (cx, cy, s) => (x, y) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
const emptyGrid = () => grid(() => 0);

const exposure = grid((x, y) =>
  Math.max(...sensors.filter((s) => s.side === 'enemy')
    .map((s) => Math.max(0, 1 - Math.hypot(x - s.x, y - s.y) / s.range_m) ** 0.7)));

// Friendly launch-site concealment (mirrors planning/launch_sites.py): outside coverage, far from its edge,
// and an unobserved first 1.5 km of flight.
const HOME = { x: 8500, y: 1000 };
const launchSites = (() => {
  const ev = exposure.values, cov = [];
  ev.forEach((r, row) => r.forEach((v, col) => v >= 0.2 && cov.push([row, col])));
  const k = Math.round(1500 / CELL);
  const raw = ev.map((r, row) => r.map((e, col) => {
    if (e > 0.05) return 0;
    const standoff = cov.length ? Math.min(...cov.map(([cr, cc]) => Math.hypot(cr - row, cc - col))) * CELL : Infinity;
    let sum = 0, n = 0;
    for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) {
      const rr = row + dr, cc = col + dc;
      if (dr * dr + dc * dc > k * k || rr < 0 || cc < 0 || rr >= GN || cc >= GN) continue;
      sum += ev[rr][cc]; n++;
    }
    return { v: (1 - e) * (0.5 * Math.min(1, standoff / 2000) + 0.5 * (1 - sum / n)), standoff, local: sum / n };
  }));
  const max = Math.max(...raw.flat().map((c) => (c ? c.v : 0)));
  const values = raw.map((r) => r.map((c) => (c ? r2(c.v / max) : 0)));
  const cells = raw.flatMap((r, row) => r.map((c, col) => ({ c, row, col, x: (col + 0.5) * CELL, y: (row + 0.5) * CELL })))
    .filter((q) => q.c && values[q.row][q.col] > 0 && dist(q, HOME) <= 4000)
    .sort((a, b) => values[b.row][b.col] - values[a.row][a.col] || dist(a, HOME) - dist(b, HOME));
  const options = [];
  for (const q of cells) {
    if (options.length >= 3) break;
    if (options.some((o) => dist(o, q) < 1000)) continue;
    options.push({ x: q.x, y: q.y, concealment: values[q.row][q.col], exposure_at_site: r2(ev[q.row][q.col]),
      distance_to_coverage_m: Math.round(q.c.standoff), nearest_enemy_sensor: 'ES2',
      reason: `${(q.c.standoff / 1000).toFixed(1)} km outside ES2 coverage; the first 1.5 km of flight is ${q.c.local < 0.01 ? 'unobserved' : `${Math.round(q.c.local * 100)}% exposed`}.` });
  }
  return { grid: { cell_m: CELL, width: GN, height: GN, values }, options };
})();

const routes = [
  { id: 'F1', waypoints: [{ x: 8500, y: 1000 }, { x: 6500, y: 4000 }, { x: 5000, y: 6500 }],
    risk: 0.71, risk_level: 'high', exposed_by: ['ES2'],
    safer_waypoints: [{ x: 8500, y: 1000 }, { x: 7600, y: 3800 }, { x: 6800, y: 6000 }, { x: 5000, y: 6500 }] },
  { id: 'F2', waypoints: [{ x: 8500, y: 1000 }, { x: 7500, y: 4000 }],
    risk: 0.12, risk_level: 'low', exposed_by: [], safer_waypoints: null },
];

let detSeq = 0;
const frames = [];
const tracks = {}; // track id -> running state
const alerts = {
  3: [{ t: 3, kind: 'new_track', message: 'New track T1 detected by S1 and S3.',
    recommended_action: 'Monitor T1; origin estimate pending.', ref_id: 'T1' }],
  6: [{ t: 6, kind: 'route_exposed', message: 'Friendly route F1 is exposed to enemy sensor ES2 (risk 71%).',
    recommended_action: 'Use the safer corridor for F1.', ref_id: 'F1' }],
  7: [{ t: 7, kind: 'origin_confident', message: 'Launch area for T1 located near (1716, 3712), confidence 77%.',
    recommended_action: 'Launch area located; consider a survey.', ref_id: 'T1' }],
};

for (let t = 0; t < N_FRAMES; t++) {
  const detections = [];
  for (const d of drones) {
    const p = truthAt(d, t);
    if (!p) continue;
    for (const s of allied) {
      if (dist(p, s) > s.range_m) continue;
      const sig = SIGMA[s.type];
      detections.push({ id: `D-${String(++detSeq).padStart(6, '0')}`, t, sensor_id: s.id,
        x: r1(p.x + gauss() * sig), y: r1(p.y + gauss() * sig), sigma_m: sig, clutter: false, truth_drone_id: d.id });
    }
  }
  // ~15% clutter: random points inside a random allied sensor's range.
  const nClutter = Math.round((detections.length * 0.15) / 0.85 + (rand() - 0.5));
  for (let i = 0; i < nClutter; i++) {
    const s = allied[Math.floor(rand() * allied.length)];
    const a = rand() * 2 * Math.PI, r = Math.sqrt(rand()) * s.range_m;
    detections.push({ id: `D-${String(++detSeq).padStart(6, '0')}`, t, sensor_id: s.id,
      x: r1(s.x + r * Math.cos(a)), y: r1(s.y + r * Math.sin(a)), sigma_m: SIGMA[s.type], clutter: true,
      truth_drone_id: null });
  }

  const frameTracks = [];
  const origins = [];
  for (const d of drones) {
    const mine = detections.filter((x) => x.truth_drone_id === d.id);
    const st = (tracks[d.track] ??= { seen: 0, sensors: new Set(), points: [] });
    if (mine.length) st.seen++;
    mine.forEach((x) => st.sensors.add(x.sensor_id));
    if (st.seen < 3) continue; // track forms after 3 seconds of detections
    const p = truthAt(d, t);
    st.points.push({ t, x: r1(p.x + gauss() * 25), y: r1(p.y + gauss() * 25) });
    const age = st.points.length;
    const major = Math.max(60, 220 - age * 14), minor = Math.max(35, 120 - age * 8);
    frameTracks.push({ id: d.track, status: 'active', sensor_ids: [...st.sensors].sort(),
      points: st.points.map((q) => ({ ...q })),
      current: { x: st.points[age - 1].x, y: st.points[age - 1].y, vx: r1(d.vx + gauss() * 3), vy: r1(d.vy + gauss() * 3) },
      ellipse: { major_m: major, minor_m: minor, angle_deg: r1((Math.atan2(d.vy, d.vx) * 180) / Math.PI) } });
    if (age >= 3) {
      const err = 700 / age;
      const radius = Math.round(150 + 1600 / age);
      const conf = r2(Math.min(1, age / 5) * Math.min(1, Math.max(0.1, 1 - radius / 2000)));
      origins.push({ track_id: d.track, peak: { x: Math.round(d.from.x - err * 0.6), y: Math.round(d.from.y + err * 0.8) },
        confidence: conf, radius_m: radius });
    }
  }

  const launch_teams = [];
  if (origins.length) {
    const hist = origins
      .map((o) => ({ t: drones.find((d) => d.track === o.track_id).launch_t, x: o.peak.x, y: o.peak.y }))
      .sort((a, b) => a.t - b.t);
    launch_teams.push({ id: 'LT1', origin_history: hist, track_ids: origins.map((o) => o.track_id) });
  }

  const origin_heatmap = origins.length
    ? grid((x, y) => origins.reduce((acc, o) => acc + o.confidence * gaussAt(o.peak.x, o.peak.y, o.radius_m)(x, y), 0))
    : emptyGrid();
  let forecast_heatmap = emptyGrid();
  const lt = launch_teams[0];
  if (lt) {
    const h = lt.origin_history, last = h[h.length - 1];
    const step = h.length > 1 ? { x: last.x - h[h.length - 2].x, y: last.y - h[h.length - 2].y } : { x: 0, y: 0 };
    forecast_heatmap = grid(gaussAt(last.x + step.x, last.y + step.y, 600));
  }

  frames.push({ t, detections, tracks: frameTracks, origins, launch_teams, origin_heatmap, forecast_heatmap,
    exposure_grid: exposure, routes, recon: null, confirmed_sites: [], alerts: alerts[t] ?? [] });
}

const scenario = {
  id: 'demo', name: 'Two launch teams, cluttered sensors (fixture)', seed: SEED,
  map: { width_m: 10000, height_m: 10000, cell_m: 100 },
  duration_s: N_FRAMES, sensors,
  sensor_suggestion: { x: 3000, y: 2500, uncertainty_reduction: 0.31,
    reason: 'Covers the gap south-west of S3 where T1 and T2 originate.' },
  launch_site_grid: launchSites.grid, launch_site_options: launchSites.options,
  recon_route: { id: 'R1', waypoints: [{ x: 8500, y: 1000 }, { x: 5500, y: 2000 }, { x: 3500, y: 2600 },
    { x: 2600, y: 3400 }, { x: 8500, y: 1000 }],
    info_gain: 0.58, risk: 0.21, geofence: { x_min: 2100, x_max: 9000, y_min: 500, y_max: 3900 },
    status: 'proposed', approved_by: null, approved_at: null, log: [{ t: 14, event: 'proposed' }] },
  metrics: { origin_error_m_by_t: { 30: 410, 60: 210, 90: 95, 120: 70 }, track_rmse_m: 48, clutter_filtered_pct: 94,
    label: 'Measured on simulated data' },
  frames,
};

const all = frames.flatMap((f) => f.detections);
const clutterPct = (100 * all.filter((d) => d.clutter).length) / all.length;
writeFileSync(new URL('./scenario_demo.json', import.meta.url), JSON.stringify(scenario));
console.log(`frames=${frames.length} detections=${all.length} clutter=${clutterPct.toFixed(1)}%`);
