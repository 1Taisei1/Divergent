// Inference engine behind the ops heat maps: turns fragmented detections, tracks and sensor geometry into fields.
// Every field here is a MODEL ESTIMATE computed from SIMULATED data: a decision aid, not ground truth.
// Pure and deterministic. Grids are 100 x 100 cells of 100 m (row 0 = south); Float32Array inside, number[][] out.
import type { Frame, Grid, Point, Scenario, Sensor, SensorType, TimedPoint } from '../types';
import { EXAGGERATION, HOME_BASE, type ElevationFn } from './geo3d';

const N = 100, CELL = 100, SIZE = N * CELL;
const MAST_M: Record<SensorType, number> = { radar: 15, rf: 10, acoustic: 3 };
const PEAK_PD: Record<SensorType, number> = { radar: 0.95, rf: 0.9, acoustic: 0.85 };
const DEG = Math.PI / 180;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);
const mid = (i: number) => (i + 0.5) * CELL; // cell index → cell-centre coordinate

// ---------- grid plumbing ----------

const flat = new WeakMap<Grid, Float32Array>();

function toGrid(buf: Float32Array): Grid {
  const values: number[][] = new Array(N);
  for (let r = 0; r < N; r++) values[r] = Array.from(buf.subarray(r * N, r * N + N));
  const g = { cell_m: CELL, width: N, height: N, values };
  flat.set(g, buf); // later stages read our own grids without re-flattening
  return g;
}

function asBuf(g: Grid): Float32Array {
  let b = flat.get(g);
  if (b) return b;
  b = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const row = g.values[r];
    if (row) for (let c = 0; c < N; c++) b[r * N + c] = row[c] ?? 0;
  }
  flat.set(g, b);
  return b;
}

function normalize(b: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < b.length; i++) if (b[i] > m) m = b[i];
  if (m > 0) for (let i = 0; i < b.length; i++) b[i] /= m;
  return b;
}

// Bilinear read of a 100 x 100 buffer at sim meters (clamped to the box).
function sample(b: Float32Array, x: number, y: number): number {
  const gx = clamp(x / CELL - 0.5, 0, N - 1), gy = clamp(y / CELL - 0.5, 0, N - 1);
  const c0 = Math.floor(gx), r0 = Math.floor(gy), c1 = Math.min(N - 1, c0 + 1), r1 = Math.min(N - 1, r0 + 1);
  const kx = gx - c0, ky = gy - r0;
  return (b[r0 * N + c0] * (1 - kx) + b[r0 * N + c1] * kx) * (1 - ky) + (b[r1 * N + c0] * (1 - kx) + b[r1 * N + c1] * kx) * ky;
}

// Separable Gaussian blur, sigma in cells (returns a new buffer).
function blurBuf(src: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 2.5);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[y * N + clamp(x + i, 0, N - 1)] * k[i + r];
    tmp[y * N + x] = s / ks;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[clamp(y + i, 0, N - 1) * N + x] * k[i + r];
    out[y * N + x] = s / ks;
  }
  return out;
}

// Adds w·exp(-d²/2σ²) out to 2.5σ.
function splat(b: Float32Array, x: number, y: number, sigma: number, w: number) {
  const reach = 2.5 * sigma, inv = 1 / (2 * sigma * sigma);
  const c0 = Math.max(0, Math.floor((x - reach) / CELL)), c1 = Math.min(N - 1, Math.floor((x + reach) / CELL));
  const r0 = Math.max(0, Math.floor((y - reach) / CELL)), r1 = Math.min(N - 1, Math.floor((y + reach) / CELL));
  for (let r = r0; r <= r1; r++) {
    const dy = mid(r) - y;
    for (let c = c0; c <= c1; c++) {
      const dx = mid(c) - x, d2 = dx * dx + dy * dy;
      if (d2 <= reach * reach) b[r * N + c] += w * Math.exp(-d2 * inv);
    }
  }
}

// Anisotropic Gaussian (long axis along unit (ux, uy)), max-combined so overlapping prediction steps form an envelope.
function splatMax(b: Float32Array, x: number, y: number, ux: number, uy: number, sAlong: number, sCross: number, w: number) {
  const reach = 2.5 * Math.max(sAlong, sCross), ia = 1 / (sAlong * sAlong), ic = 1 / (sCross * sCross);
  const c0 = Math.max(0, Math.floor((x - reach) / CELL)), c1 = Math.min(N - 1, Math.floor((x + reach) / CELL));
  const r0 = Math.max(0, Math.floor((y - reach) / CELL)), r1 = Math.min(N - 1, Math.floor((y + reach) / CELL));
  for (let r = r0; r <= r1; r++) {
    const dy = mid(r) - y;
    for (let c = c0; c <= c1; c++) {
      const dx = mid(c) - x, a = dx * ux + dy * uy, q = dy * ux - dx * uy;
      const v = w * Math.exp(-0.5 * (a * a * ia + q * q * ic));
      if (v > b[r * N + c]) b[r * N + c] = v;
    }
  }
}

// Remembers the last few results by argument identity, so re-renders at the same second reuse the same Grid
// (and therefore the heat image cached on it).
function memo<A extends unknown[]>(fn: (...a: A) => Grid, size = 12): (...a: A) => Grid {
  const hits: { args: A; out: Grid }[] = [];
  return (...args: A) => {
    const h = hits.find((e) => e.args.every((v, i) => v === args[i]));
    if (h) return h.out;
    const out = fn(...args);
    hits.unshift({ args, out });
    if (hits.length > size) hits.pop();
    return out;
  };
}

// ---------- scenario access ----------

// Last frame at or before t (frames are sorted by t).
function frameAt(s: Scenario, t: number): Frame | null {
  const f = s.frames;
  if (!f.length) return null;
  if (t <= f[0].t) return f[0];
  let lo = 0, hi = f.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (f[m].t <= t) lo = m; else hi = m - 1;
  }
  return f[lo];
}

// Number of points with p.t <= t.
function fixesUpTo(pts: TimedPoint[], t: number): number {
  let k = pts.length;
  while (k > 0 && pts[k - 1].t > t) k--;
  return k;
}

// All non-clutter detections of a scenario, sorted by time, as typed arrays.
type DetIndex = { t: Float32Array; x: Float32Array; y: Float32Array; sigma: Float32Array };
const detIndexes = new WeakMap<Scenario, DetIndex>();
function detIndex(s: Scenario): DetIndex {
  const hit = detIndexes.get(s);
  if (hit) return hit;
  const all = s.frames.flatMap((f) => f.detections.filter((d) => !d.clutter)).sort((a, b) => a.t - b.t);
  const idx: DetIndex = {
    t: Float32Array.from(all, (d) => d.t), x: Float32Array.from(all, (d) => d.x),
    y: Float32Array.from(all, (d) => d.y), sigma: Float32Array.from(all, (d) => d.sigma_m),
  };
  detIndexes.set(s, idx);
  return idx;
}

// Mean heading (unit vector), speed and the angular uncertainty of that heading (rad) from fixes pts[i0..i1].
function heading(pts: TimedPoint[], i0: number, i1: number): { ux: number; uy: number; speed: number; spread: number } | null {
  let sx = 0, sy = 0, m = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    sx += (pts[i].x - pts[i - 1].x) / dt; sy += (pts[i].y - pts[i - 1].y) / dt; m++;
  }
  if (!m) return null;
  const mx = sx / m, my = sy / m, speed = Math.hypot(mx, my);
  if (speed < 0.5) return null;
  const th = Math.atan2(my, mx);
  let v = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) - th;
    const d = Math.atan2(Math.sin(a), Math.cos(a));
    v += d * d;
  }
  // Scatter of the per-step headings, shrunk by sqrt(m) because the mean heading averages m noisy steps.
  return { ux: mx / speed, uy: my / speed, speed, spread: Math.sqrt(v / m) / Math.sqrt(m) };
}

// ---------- terrain ----------

const EG_STEP = 50, EG_N = SIZE / EG_STEP + 1; // 201 x 201 height nodes, true meters
const terrains = new WeakMap<ElevationFn, Float32Array>();
function terrain(elev: ElevationFn): Float32Array {
  let h = terrains.get(elev);
  if (h) return h;
  h = new Float32Array(EG_N * EG_N);
  for (let j = 0; j < EG_N; j++) for (let i = 0; i < EG_N; i++) h[j * EG_N + i] = elev(i * EG_STEP, j * EG_STEP) / EXAGGERATION;
  terrains.set(elev, h);
  return h;
}

function heightAt(h: Float32Array, x: number, y: number): number {
  const gx = clamp(x / EG_STEP, 0, EG_N - 1), gy = clamp(y / EG_STEP, 0, EG_N - 1);
  const i0 = Math.min(EG_N - 2, Math.floor(gx)), j0 = Math.min(EG_N - 2, Math.floor(gy)), kx = gx - i0, ky = gy - j0;
  const a = h[j0 * EG_N + i0], b = h[j0 * EG_N + i0 + 1], c = h[(j0 + 1) * EG_N + i0], d = h[(j0 + 1) * EG_N + i0 + 1];
  return (a * (1 - kx) + b * kx) * (1 - ky) + (c * (1 - kx) + d * kx) * ky;
}

// Soft line of sight from (ax, ay, az) to (bx, by, bz): the ray is sampled every <= 100 m, and its smallest clearance
// above terrain maps to 1 (clear by 10 m) .. 0 (buried 10 m), so masking edges are not aliased.
function lineOfSight(h: Float32Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 100);
  let min = Infinity;
  for (let i = 1; i < n; i++) {
    const f = i / n, clr = az + (bz - az) * f - heightAt(h, ax + (bx - ax) * f, ay + (by - ay) * f);
    if (clr < min) min = clr;
  }
  return min === Infinity ? 1 : clamp01(0.5 + min / 20);
}

// ---------- detection probability (static, memoized) ----------

const NO_ELEV = {};
const detCache = new WeakMap<object, WeakMap<Sensor[], Map<string, Grid>>>();

// P(a drone at droneAglM in the cell is detected by an active sensor of `side`): range falloff 1-(r/R)² times terrain
// line of sight from the mast, combined as 1 - prod(1 - p_i). A probability, so NOT normalized. Acoustic sensors keep
// part of their reach behind terrain (sound diffracts).
export function detectionField(sensors: Sensor[], side: 'allied' | 'enemy', elev: ElevationFn | null, droneAglM = 60): Grid {
  const ek = elev ?? NO_ELEV;
  let bySensors = detCache.get(ek);
  if (!bySensors) detCache.set(ek, (bySensors = new WeakMap()));
  let byKey = bySensors.get(sensors);
  if (!byKey) bySensors.set(sensors, (byKey = new Map()));
  const key = `${side}|${droneAglM}`;
  const hit = byKey.get(key);
  if (hit) return hit;

  const h = elev ? terrain(elev) : null;
  const miss = new Float32Array(N * N).fill(1);
  for (const s of sensors) {
    if (!s.active || s.side !== side || s.range_m <= 0) continue;
    const R = s.range_m, R2 = R * R, mastZ = h ? heightAt(h, s.x, s.y) + MAST_M[s.type] : 0;
    const c0 = Math.max(0, Math.floor((s.x - R) / CELL)), c1 = Math.min(N - 1, Math.floor((s.x + R) / CELL));
    const r0 = Math.max(0, Math.floor((s.y - R) / CELL)), r1 = Math.min(N - 1, Math.floor((s.y + R) / CELL));
    for (let r = r0; r <= r1; r++) {
      const y = mid(r), dy = y - s.y;
      for (let c = c0; c <= c1; c++) {
        const x = mid(c), dx = x - s.x, d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        let p = PEAK_PD[s.type] * (1 - d2 / R2);
        if (h) {
          const vis = lineOfSight(h, s.x, s.y, mastZ, x, y, heightAt(h, x, y) + droneAglM);
          p *= s.type === 'acoustic' ? 0.4 + 0.6 * vis : vis;
        }
        miss[r * N + c] *= 1 - p;
      }
    }
  }
  for (let i = 0; i < miss.length; i++) miss[i] = 1 - miss[i];
  const g = toGrid(miss);
  byKey.set(key, g);
  return g;
}

// ---------- hostile activity ----------

const DET_HALF_LIFE_S = 20, TRACK_HALF_LIFE_S = 40, PREDICT_S = 30, MAX_GAP_S = 60;

const activity = memo((s: Scenario, t: number): Grid => {
  const f = frameAt(s, t);
  const D = new Float32Array(N * N), T = new Float32Array(N * N), P = new Float32Array(N * N), out = new Float32Array(N * N);

  // 1. Kernel density of the raw (fragmented) detections, recent ones weighted more.
  const di = detIndex(s);
  for (let i = 0; i < di.t.length && di.t[i] <= t; i++) {
    const w = Math.pow(0.5, (t - di.t[i]) / DET_HALF_LIFE_S);
    if (w > 0.02) splat(D, di.x[i], di.y[i], Math.hypot(di.sigma[i], 120), w);
  }

  for (const tr of f?.tracks ?? []) {
    const k = fixesUpTo(tr.points, t);
    if (!k) continue;
    // 2. The tracker's filtered points (they bridge single-sensor gaps).
    for (let i = 0; i < k; i++) {
      const p = tr.points[i], w = Math.pow(0.5, (t - p.t) / TRACK_HALF_LIFE_S);
      if (w > 0.02) splat(T, p.x, p.y, 110, w);
    }
    // 3. Dead reckoning beyond the last fix: a cone along the velocity that widens with the heading scatter and time.
    //    This is what puts heat where no sensor currently sees.
    const last = tr.points[k - 1], gap = t - last.t;
    const { vx, vy } = tr.current, speed = Math.hypot(vx, vy);
    if (gap > MAX_GAP_S || speed < 0.5) continue;
    const ux = vx / speed, uy = vy / speed;
    const tan = Math.tan(clamp(heading(tr.points, Math.max(0, k - 9), k - 1)?.spread ?? 15 * DEG, 6 * DEG, 35 * DEG));
    const fade = tr.status === 'lost' ? 0.7 : 1;
    for (let tau = 2; tau <= gap + PREDICT_S; tau += 2) {
      const x = last.x + vx * tau, y = last.y + vy * tau;
      if (x < -500 || y < -500 || x > SIZE + 500 || y > SIZE + 500) break;
      splatMax(P, x, y, ux, uy, 80 + 0.2 * speed * tau, 80 + speed * tau * tan, fade * Math.exp(-tau / 50));
    }
  }

  let dMax = 0, tMax = 0;
  for (let i = 0; i < D.length; i++) { if (D[i] > dMax) dMax = D[i]; if (T[i] > tMax) tMax = T[i]; }
  for (let i = 0; i < out.length; i++) {
    const d = dMax > 0 ? Math.sqrt(D[i] / dMax) : 0, tt = tMax > 0 ? Math.sqrt(T[i] / tMax) : 0;
    out[i] = 1 - (1 - 0.9 * d) * (1 - 0.75 * tt) * (1 - 0.8 * P[i]);
  }
  return toGrid(normalize(out));
});

// Where hostile drones are or will be over the next ~30 s, from the fragmented data up to t. Normalized 0..1.
export function hostileActivityField(scenario: Scenario, t: number): Grid {
  return activity(scenario, frameAt(scenario, t)?.t ?? t);
}

// ---------- enemy launch origins ----------

const APEX_M = 180, DEPTH_M = 3500, SEEN_K = 0.7, ALPHA = 6;

// One track's back-projected launch cone (unweighted likelihood). It only depends on the first fixes and the allied
// coverage, so it is cached per track and recomputed only while the track is younger than its fix window.
const cones = new WeakMap<Scenario, WeakMap<Float32Array, Map<string, Float32Array>>>();
function launchCone(s: Scenario, pts: TimedPoint[], k: number, pd: Float32Array, id: string): Float32Array | null {
  const K = Math.min(k, 8), p0 = pts[0];
  let byPd = cones.get(s);
  if (!byPd) cones.set(s, (byPd = new WeakMap()));
  let byTrack = byPd.get(pd);
  if (!byTrack) byPd.set(pd, (byTrack = new Map()));
  const key = `${id}|${K}|${p0.t}|${p0.x}|${p0.y}`;
  const hit = byTrack.get(key);
  if (hit) return hit;

  const hd = heading(pts, 0, K - 1);
  if (!hd) return null;
  const tan = Math.tan(clamp(hd.spread, 8 * DEG, 40 * DEG)), bx = -hd.ux, by = -hd.uy; // back along the heading
  const L = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const y = mid(r), dy = y - p0.y;
    for (let c = 0; c < N; c++) {
      const x = mid(c), dx = x - p0.x, along = dx * bx + dy * by, cross = Math.abs(dy * bx - dx * by);
      if (along < -3 * APEX_M) continue;
      const width = APEX_M + Math.max(0, along) * tan;
      const cone = Math.exp(-0.5 * (cross / width) ** 2) * (along < 0 ? Math.exp(-0.5 * (along / APEX_M) ** 2) : Math.exp(-along / DEPTH_M));
      if (cone < 0.01) continue;
      // Negative information: launching here means the drone crossed cell → first fix unseen, so allied coverage along
      // that leg makes the cell less likely; and a launch team sits where our sensors could not see it.
      const dist = Math.hypot(dx, dy), n = Math.ceil(dist / CELL);
      let seen = 0;
      for (let i = 1; i < n; i++) seen += sample(pd, x - (dx * i) / n, y - (dy * i) / n);
      const hidden = (1 - pd[r * N + c]) ** 3;
      L[r * N + c] = cone * Math.exp((-SEEN_K * seen * dist) / Math.max(1, n) / CELL) * (0.05 + 0.95 * hidden);
    }
  }
  byTrack.set(key, L);
  return L;
}

const origins = memo((s: Scenario, t: number, allied: Grid): Grid => {
  const f = frameAt(s, t);
  const pd = asBuf(allied), score = new Float32Array(N * N), sharp = new Float32Array(N * N);
  if (!f) return toGrid(score);
  const conf = new Map(f.origins.map((o) => [o.track_id, o.confidence]));

  // Each track's cone, scaled by its origin confidence; log(1 + a·w·L) summed over tracks so cells where several
  // tracks' cones intersect light up most, without zeroing cells only one track supports.
  for (const tr of f.tracks) {
    const k = fixesUpTo(tr.points, t);
    if (k < 3) continue;
    const L = launchCone(s, tr.points, k, pd, tr.id);
    if (!L) continue;
    const w = conf.get(tr.id) ?? 0.4;
    for (let i = 0; i < L.length; i++) if (L[i] > 0) score[i] += Math.log1p(ALPHA * w * L[i]);
  }

  // Sharp evidence: the tracker's origin estimates and any recon-confirmed sites (max-combined, then added once).
  const evidence = (p: Point, radius: number, w: number) => {
    const sigma = Math.max(150, radius), reach = 3 * sigma, inv = 1 / (2 * sigma * sigma);
    const c0 = Math.max(0, Math.floor((p.x - reach) / CELL)), c1 = Math.min(N - 1, Math.floor((p.x + reach) / CELL));
    const r0 = Math.max(0, Math.floor((p.y - reach) / CELL)), r1 = Math.min(N - 1, Math.floor((p.y + reach) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const dx = mid(c) - p.x, dy = mid(r) - p.y, v = w * Math.exp(-(dx * dx + dy * dy) * inv);
      if (v > sharp[r * N + c]) sharp[r * N + c] = v;
    }
  };
  for (const o of f.origins) evidence(o.peak, o.radius_m, o.confidence);
  for (const site of f.confirmed_sites) evidence(site, site.radius_m, 1);
  for (let i = 0; i < score.length; i++) score[i] += Math.log1p(ALPHA * sharp[i]);
  return toGrid(normalize(score));
});

// Launch-origin likelihood: tracks back-projected as cones into ground the allied sensors could not see, scaled by
// origin confidence and fused across tracks, plus the origin estimates as sharp evidence. Normalized 0..1.
export function enemyOriginField(scenario: Scenario, t: number, alliedDetect: Grid): Grid {
  return origins(scenario, frameAt(scenario, t)?.t ?? t, alliedDetect);
}

// ---------- safe launch ----------

// Terrain masking per cell, 0..1 (static): out of line of sight of every enemy mast for a 5 m launch point, and sitting
// below the terrain ring 500 m around it (valley).
const masks = new WeakMap<ElevationFn, WeakMap<Sensor[], Float32Array>>();
const RING = Array.from({ length: 8 }, (_, i) => [500 * Math.cos((i * Math.PI) / 4), 500 * Math.sin((i * Math.PI) / 4)]);
function terrainMask(sensors: Sensor[], elev: ElevationFn): Float32Array {
  let bySensors = masks.get(elev);
  if (!bySensors) masks.set(elev, (bySensors = new WeakMap()));
  const hit = bySensors.get(sensors);
  if (hit) return hit;
  const h = terrain(elev), enemies = sensors.filter((s) => s.side === 'enemy' && s.active);
  const masts = enemies.map((s) => heightAt(h, s.x, s.y) + MAST_M[s.type]);
  const m = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const x = mid(c), y = mid(r), g = heightAt(h, x, y);
    let ring = 0;
    for (const [ox, oy] of RING) ring += heightAt(h, x + ox, y + oy);
    const valley = clamp01(0.5 + (ring / RING.length - g) / 60);
    let hidden = 1;
    enemies.forEach((s, i) => {
      if (Math.hypot(x - s.x, y - s.y) > 1.3 * s.range_m) return;
      hidden = Math.min(hidden, 1 - lineOfSight(h, s.x, s.y, masts[i], x, y, g + 5));
    });
    m[r * N + c] = 0.6 * hidden + 0.4 * valley;
  }
  bySensors.set(sensors, m);
  return m;
}

const safe = memo((s: Scenario, t: number, enemy: Grid, act: Grid, elev: ElevationFn | null): Grid => {
  const f = frameAt(s, t);
  const det = asBuf(enemy), a = asBuf(act), mask = elev ? terrainMask(s.sensors, elev) : null;
  const enemies = s.sensors.filter((x) => x.side === 'enemy' && x.active);
  // Enemy launch sites, deduplicated to ~300 m (several tracks often share one site).
  const sites = new Map<string, Point>();
  for (const p of [...(f?.origins.map((o) => o.peak) ?? []), ...(f?.confirmed_sites ?? [])]) sites.set(`${Math.round(p.x / 300)},${Math.round(p.y / 300)}`, p);
  const SITE_R2 = (3 * 1200) ** 2;

  // Where our drones head after launch: toward the hostile activity (fallback: enemy sensors, then the box centre).
  let tx = 0, ty = 0, tw = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 0.15) { const w = a[i] * a[i]; tx += w * mid(i % N); ty += w * mid(Math.floor(i / N)); tw += w; }
  if (!tw) for (const e of enemies) { tx += e.x; ty += e.y; tw++; }
  const target = tw ? { x: tx / tw, y: ty / tw } : { x: SIZE / 2, y: SIZE / 2 };

  const out = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const i = r * N + c, x = mid(c), y = mid(r);
    const dl = Math.hypot(target.x - x, target.y - y), ux = dl > 1 ? (target.x - x) / dl : 0, uy = dl > 1 ? (target.y - y) / dl : 0;
    // Climb-out exposure: detection at the site and along the first ~1 km toward the target.
    let climb = det[i];
    for (let k = 1; k <= 4; k++) climb = Math.max(climb, 0.85 * sample(det, x + ux * 250 * k, y + uy * 250 * k));
    let v = (1 - climb) ** 2;
    v *= Math.exp(-2.5 * a[i]); // hostile drones overhead
    const dh = Math.hypot(x - HOME_BASE.x, y - HOME_BASE.y); // reachability from home base
    v *= dh <= 4000 ? 1 - (0.15 * dh) / 4000 : 0.85 * Math.exp(-(((dh - 4000) / 2000) ** 2));
    v *= 0.55 + 0.45 * (1 - Math.min(1, dl / 8000)); // shorter transit to where the activity is
    for (const p of sites.values()) { // standoff from enemy launch teams
      const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d2 < SITE_R2) v *= 1 - 0.85 * Math.exp(-d2 / (2 * 1200 * 1200));
    }
    for (const e of enemies) { // sensor ranges are estimates: keep a soft margin outside them
      const d = Math.hypot(x - e.x, y - e.y);
      if (d > e.range_m) v *= 1 - 0.3 * Math.exp(-(d - e.range_m) / 700);
    }
    if (mask) v *= 0.45 + 0.55 * mask[i];
    out[i] = v;
  }
  // Contrast: only the best few percent read red, so the map ranks sites instead of painting everything "fine".
  normalize(out);
  for (let i = 0; i < out.length; i++) out[i] = out[i] ** 2.5;
  return toGrid(out);
});

// Where it is safest for us to launch (1 = safest): low enemy detection of the climb-out, terrain masking from enemy
// masts, low hostile activity, standoff from enemy launch sites, reachable from HOME_BASE. Normalized 0..1.
export function safeLaunchField(scenario: Scenario, t: number, enemyDetect: Grid, activity: Grid, elev: ElevationFn | null): Grid {
  return safe(scenario, frameAt(scenario, t)?.t ?? t, enemyDetect, activity, elev);
}

// ---------- route threat ----------

const route = memo((enemy: Grid, act: Grid, origin: Grid): Grid => {
  const d = asBuf(enemy), a = asBuf(act), o = blurBuf(asBuf(origin), 2);
  const out = new Float32Array(N * N);
  for (let i = 0; i < out.length; i++) {
    const aa = clamp01((a[i] - 0.04) / 0.96), oo = clamp01((o[i] - 0.08) / 0.92); // faint tails count as clear
    out[i] = 1 - (1 - 0.95 * d[i]) * (1 - 0.7 * aa) * (1 - 0.6 * oo);
  }
  return toGrid(out);
});

// Threat for route planning (1 = dangerous): enemy detection probability, hostile activity, and proximity to likely
// enemy launch areas. 0..1 and NOT renormalized, so 0 means genuinely clear.
export function routeThreatField(enemyDetect: Grid, activity: Grid, originField: Grid): Grid {
  return route(enemyDetect, activity, originField);
}
