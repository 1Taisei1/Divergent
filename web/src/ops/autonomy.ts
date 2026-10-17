// AUTONOMOUS SURVEY (simulated). Once a named human operator arms it, the survey drone loops MAP -> PLAN -> FLY -> UPDATE
// on its own: it builds a value map (where the enemy-origin prior is high and we have not looked yet), plans the next
// leg by information gain per metre minus threat, flies it while its camera marks ground as mapped, then recomputes.
// Guardrails: geofence on every leg, legs over the risk limit are rejected, automatic return-to-home on low battery,
// on high threat at the drone, or once the valuable area is mapped; the operator can abort at any time.
// Surveillance and mapping only. Pure and deterministic (no randomness): same inputs, same mission.
import type { Layer } from '@deck.gl/core';
import { IconLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Grid, Point } from '../types';
import { HOME_BASE } from './geo3d';

export interface MissionConfig {
  geofence: { x0: number; y0: number; x1: number; y1: number };
  home: Point;
  speedMs: number;
  footprintM: number; // camera footprint radius on the ground
  altitudeAglM: number;
  maxRisk: number; // 0..1, legs whose peak threat is above this are rejected; threat above this at the drone forces RTH
  enduranceS: number;
}

const BOX = 10000, MARGIN = 300;
export const DEFAULT_MISSION: MissionConfig = {
  geofence: { x0: MARGIN, y0: MARGIN, x1: BOX - MARGIN, y1: BOX - MARGIN },
  home: HOME_BASE,
  speedMs: 22,
  footprintM: 700,
  altitudeAglM: 120,
  maxRisk: 0.6,
  enduranceS: 900,
};

export type MissionPhase = 'idle' | 'armed' | 'mapping' | 'planning' | 'flying' | 'updating' | 'returning' | 'complete' | 'aborted';

export interface Finding { kind: 'launch_site' | 'hostile_drone'; x: number; y: number; t: number; ref: string; confidence: number }

export interface MissionLogEntry { t: number; phase: MissionPhase; msg: string }

export interface MissionState {
  phase: MissionPhase;
  clockS: number; // mission clock, seconds since arming
  pos: Point;
  headingDeg: number; // compass, 0 = north, clockwise
  flown: Point[];
  plan: Point[]; // upcoming waypoints; plan[0] is the leg being flown
  covered: Float32Array; // 100x100, row 0 = south, 0..1 mapped
  uncertainty: Grid; // what is still unknown, red = high value to survey
  findings: Finding[];
  log: MissionLogEntry[];
  operator: string | null;
  coverage: number; // 0..1 of the valuable area mapped
  risk: number; // threat at the drone now, 0..1
  battery: number; // 0..1
  legs: number;
  // bookkeeping (not for display)
  phaseS: number;
  aborted: boolean;
  legStartS: number;
  legStartCoverage: number;
}

export type MissionContext = {
  prior: Grid | null;
  threat: Grid | null;
  origins: { track_id: string; peak: Point; confidence: number }[];
  tracks: { id: string; current: { x: number; y: number } }[];
};

// ---- tuning ----
const N = 100, CELL = 100; // covered/uncertainty grid: 100 x 100 cells of 100 m
const DWELL = { armed: 3, mapping: 5, planning: 4, updating: 4 }; // mission seconds each decision phase is shown
const FLOOR = 0.04; // planner weight of empty unknown ground, so it still sweeps when the prior is flat
const HAZE = 0.22; // display weight of empty unknown ground (faint blue haze that clears as it is mapped)
const VALUABLE = 0.2; // prior (normalised) above this counts as valuable area for the coverage goal
const GOAL = 0.85; // valuable area mapped -> survey goal met
const RESERVE_S = 45; // battery seconds kept in hand on top of the flight home
const LATTICE_M = 600, MIN_LEG = 500, MAX_LEG = 3600;
const RISK_W = 0.8; // score penalty per unit of mean threat along a leg
const BEAM = [3, 2]; // lookahead: keep 3 first legs, 2 second legs each, then the best third
const DISCOUNT = [1, 0.7, 0.5];
const SUBSTEP_S = 2, BREADCRUMB_M = 60, ARRIVE_M = 1;
const SITE_MIN_CONF = 0.25, SITE_DEDUPE_M = 500, SIGHTING_GAP_S = 60;
const HEAT_REFRESH_S = 15; // the uncertainty heat redraws at most this often while flying (and after every leg)

const AIRBORNE = new Set<MissionPhase>(['mapping', 'planning', 'flying', 'updating', 'returning']);
export const isAirborne = (p: MissionPhase) => AIRBORNE.has(p);
export const isActive = (p: MissionPhase) => p === 'armed' || AIRBORNE.has(p);

// ---- small helpers ----
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const compass = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const r10 = (v: number) => Math.round(v / 10) * 10;
const at10 = (q: Point) => `(${r10(q.x)}, ${r10(q.y)})`;
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const inFence = (cfg: MissionConfig, x: number, y: number) => {
  const g = cfg.geofence;
  return x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1;
};
function sample(g: Grid | null, x: number, y: number): number {
  if (!g || !g.values.length) return 0;
  const c = Math.min(g.width - 1, Math.max(0, Math.floor(x / g.cell_m)));
  const r = Math.min(g.height - 1, Math.max(0, Math.floor(y / g.cell_m)));
  return g.values[r]?.[c] ?? 0;
}
const fenceKey = (cfg: MissionConfig) => { const g = cfg.geofence; return `${g.x0},${g.y0},${g.x1},${g.y1}`; };

// Prior normalised to 0..1 inside the geofence, plus the planner weights and the valuable-area mask. Cached per grid.
type PriorInfo = { norm: Float32Array; w: Float32Array; covW: Float32Array; valuable: Int32Array; mass: number; fenceCells: number };
const priorCache = new WeakMap<Grid, Map<string, PriorInfo>>();
let emptyPrior: Map<string, PriorInfo> | null = null;
function priorInfo(prior: Grid | null, cfg: MissionConfig): PriorInfo {
  const key = fenceKey(cfg);
  const bucket = prior ? (priorCache.get(prior) ?? new Map<string, PriorInfo>()) : (emptyPrior ??= new Map());
  if (prior && !priorCache.has(prior)) priorCache.set(prior, bucket);
  const hit = bucket.get(key);
  if (hit) return hit;
  const raw = new Float32Array(N * N);
  const inside = new Uint8Array(N * N);
  let max = 0, fenceCells = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL;
      if (!inFence(cfg, x, y)) continue;
      inside[r * N + c] = 1;
      fenceCells++;
      const v = Math.max(0, sample(prior, x, y));
      raw[r * N + c] = v;
      if (v > max) max = v;
    }
  }
  const norm = new Float32Array(N * N), w = new Float32Array(N * N), covW = new Float32Array(N * N);
  const val: number[] = [];
  for (let i = 0; i < N * N; i++) {
    if (!inside[i]) continue;
    norm[i] = max > 1e-6 ? raw[i] / max : 0;
    w[i] = FLOOR + norm[i];
    if (norm[i] >= VALUABLE) val.push(i);
  }
  // With no usable prior the whole geofence is the valuable area, weighted evenly.
  if (!val.length) {
    for (let i = 0; i < N * N; i++) if (inside[i]) { val.push(i); covW[i] = 1; }
  } else {
    for (const i of val) covW[i] = norm[i];
  }
  let mass = 0;
  for (const i of val) mass += covW[i];
  const info = { norm, w, covW, valuable: Int32Array.from(val), mass, fenceCells };
  bucket.set(key, info);
  return info;
}

function coverageOf(covered: Float32Array, info: PriorInfo): number {
  if (info.mass <= 0) return 1;
  let s = 0;
  for (const i of info.valuable) s += info.covW[i] * covered[i];
  return s / info.mass;
}

function uncertaintyOf(covered: Float32Array, info: PriorInfo, cfg: MissionConfig): Grid {
  const values: number[][] = [];
  for (let r = 0; r < N; r++) {
    const row = new Array<number>(N);
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      row[c] = inFence(cfg, (c + 0.5) * CELL, (r + 0.5) * CELL) ? (1 - covered[i]) * (HAZE + (1 - HAZE) * info.norm[i]) : 0;
    }
    values.push(row);
  }
  return { cell_m: CELL, width: N, height: N, values };
}

// Camera footprint as a soft disc: fully mapped inside 60% of the radius, fading to nothing at the edge.
function markDisc(cov: Float32Array, x: number, y: number, rad: number) {
  const c0 = Math.max(0, Math.floor((x - rad) / CELL)), c1 = Math.min(N - 1, Math.floor((x + rad) / CELL));
  const r0 = Math.max(0, Math.floor((y - rad) / CELL)), r1 = Math.min(N - 1, Math.floor((y + rad) / CELL));
  const inner = rad * 0.6;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = Math.hypot((c + 0.5) * CELL - x, (r + 0.5) * CELL - y);
      if (d >= rad) continue;
      const q = d <= inner ? 1 : (rad - d) / (rad - inner);
      const i = r * N + c;
      if (q > cov[i]) cov[i] = q;
    }
  }
}
function markLeg(cov: Float32Array, a: Point, b: Point, rad: number) {
  const n = Math.max(1, Math.ceil(dist(a, b) / 150));
  for (let k = 0; k <= n; k++) markDisc(cov, a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, rad);
}

// ---- planner ----
// Summed-area table of value = weight x (1 - covered), so a footprint-sized box sum is O(1).
function valueSAT(covered: Float32Array, info: PriorInfo): { sat: Float64Array; total: number } {
  const W = N + 1, sat = new Float64Array(W * W);
  for (let r = 0; r < N; r++) {
    let rowSum = 0;
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      rowSum += info.w[i] * (1 - covered[i]);
      sat[(r + 1) * W + c + 1] = sat[r * W + c + 1] + rowSum;
    }
  }
  return { sat, total: sat[W * W - 1] };
}
function boxSum(sat: Float64Array, x: number, y: number, half: number): number {
  const W = N + 1;
  const c0 = Math.max(0, Math.floor((x - half) / CELL)), c1 = Math.min(N, Math.ceil((x + half) / CELL));
  const r0 = Math.max(0, Math.floor((y - half) / CELL)), r1 = Math.min(N, Math.ceil((y + half) / CELL));
  if (c1 <= c0 || r1 <= r0) return 0;
  return sat[r1 * W + c1] - sat[r0 * W + c1] - sat[r1 * W + c0] + sat[r0 * W + c0];
}
// Expected value swept by the footprint along a leg (area-equivalent boxes, rescaled for their overlap).
function legGain(sat: Float64Array, a: Point, b: Point, rad: number): number {
  const len = dist(a, b), n = Math.max(1, Math.round(len / rad)), half = rad * 0.886;
  let s = 0;
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    s += boxSum(sat, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, half);
  }
  return s * Math.min(1, (2 * len) / (n * Math.PI * rad) + 0.35);
}
function legThreat(threat: Grid | null, a: Point, b: Point): { max: number; mean: number } {
  if (!threat) return { max: 0, mean: 0 };
  const n = Math.max(1, Math.ceil(dist(a, b) / CELL));
  let max = 0, sum = 0;
  for (let k = 1; k <= n; k++) {
    const v = sample(threat, a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n);
    sum += v;
    if (v > max) max = v;
  }
  return { max, mean: sum / n };
}

const latticeCache = new Map<string, Point[]>();
function lattice(cfg: MissionConfig): Point[] {
  const key = fenceKey(cfg);
  const hit = latticeCache.get(key);
  if (hit) return hit;
  const g = cfg.geofence, pts: Point[] = [];
  const nx = Math.max(1, Math.floor((g.x1 - g.x0) / LATTICE_M)), ny = Math.max(1, Math.floor((g.y1 - g.y0) / LATTICE_M));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) pts.push({ x: g.x0 + ((g.x1 - g.x0) * i) / nx, y: g.y0 + ((g.y1 - g.y0) * j) / ny });
  latticeCache.set(key, pts);
  return pts;
}

type Leg = { to: Point; len: number; gain: number; maxThreat: number; meanThreat: number; score: number };
type PlanResult = { plan: Point[]; first: Leg; total: number; rejectedRisk: number; rejectedEnergy: number };

// Scores every lattice point as the next waypoint from `from`. Feasible = inside the geofence (by construction),
// under the risk limit along the whole leg, and leaves enough battery to fly home with the reserve.
function scoreLegs(from: Point, covered: Float32Array, info: PriorInfo, cfg: MissionConfig, threat: Grid | null, budgetM: number, stats?: { risk: number; energy: number }): { legs: Leg[]; total: number } {
  const { sat, total } = valueSAT(covered, info);
  const legs: Leg[] = [];
  let best = 0;
  for (const to of lattice(cfg)) {
    const len = dist(from, to);
    if (len < MIN_LEG || len > MAX_LEG) continue;
    if (len + dist(to, cfg.home) > budgetM) { if (stats) stats.energy++; continue; }
    const th = legThreat(threat, from, to);
    if (th.max > cfg.maxRisk) { if (stats) stats.risk++; continue; }
    const gain = legGain(sat, from, to, cfg.footprintM);
    const gpm = gain / (len + 250);
    if (gpm > best) best = gpm;
    legs.push({ to, len, gain, maxThreat: th.max, meanThreat: th.mean, score: gpm });
  }
  if (best <= 1e-9) return { legs: [], total };
  for (const l of legs) l.score = l.score / best - RISK_W * l.meanThreat;
  legs.sort((a, b) => b.score - a.score || a.to.y - b.to.y || a.to.x - b.to.x); // deterministic tie-break
  return { legs, total };
}

function planNext(s: MissionState, cfg: MissionConfig, info: PriorInfo, threat: Grid | null): PlanResult | null {
  const budget = (s.battery * cfg.enduranceS - RESERVE_S) * cfg.speedMs;
  const stats = { risk: 0, energy: 0 };
  const lvl1 = scoreLegs(s.pos, s.covered, info, cfg, threat, budget, stats);
  // Nothing worth flying for: every feasible leg sweeps less than ~1 cell of prime value.
  if (!lvl1.legs.length || lvl1.legs[0].gain < 1) return null;
  let bestTotal = -Infinity, bestPlan: Point[] = [], bestFirst = lvl1.legs[0];
  for (const l1 of lvl1.legs.slice(0, BEAM[0])) {
    const cov1 = s.covered.slice();
    markLeg(cov1, s.pos, l1.to, cfg.footprintM);
    const lvl2 = scoreLegs(l1.to, cov1, info, cfg, threat, budget - l1.len);
    let branchBest = 0, branchPlan: Point[] = [];
    for (const l2 of lvl2.legs.slice(0, BEAM[1])) {
      const cov2 = cov1.slice();
      markLeg(cov2, l1.to, l2.to, cfg.footprintM);
      const lvl3 = scoreLegs(l2.to, cov2, info, cfg, threat, budget - l1.len - l2.len);
      const s3 = lvl3.legs[0];
      const v = DISCOUNT[1] * l2.score + (s3 ? DISCOUNT[2] * s3.score : 0);
      if (v > branchBest || !branchPlan.length) { branchBest = v; branchPlan = s3 ? [l2.to, s3.to] : [l2.to]; }
    }
    const tot = DISCOUNT[0] * l1.score + branchBest;
    if (tot > bestTotal) { bestTotal = tot; bestPlan = [l1.to, ...branchPlan]; bestFirst = l1; }
  }
  return { plan: bestPlan, first: bestFirst, total: lvl1.total, rejectedRisk: stats.risk, rejectedEnergy: stats.energy };
}

// ---- state machine ----
function withLog(s: MissionState, msg: string, phase: MissionPhase = s.phase): MissionState {
  return { ...s, log: [...s.log, { t: Math.round(s.clockS * 10) / 10, phase, msg }] };
}

export function initMission(cfg: MissionConfig, prior: Grid | null, threat: Grid | null): MissionState {
  const covered = new Float32Array(N * N);
  const info = priorInfo(prior, cfg);
  return {
    phase: 'idle', clockS: 0, pos: { ...cfg.home }, headingDeg: 0, flown: [{ ...cfg.home }], plan: [], covered,
    uncertainty: uncertaintyOf(covered, info, cfg), findings: [], operator: null, coverage: 0,
    risk: sample(threat, cfg.home.x, cfg.home.y), battery: 1, legs: 0, phaseS: 0, aborted: false, legStartS: 0, legStartCoverage: 0,
    log: [{ t: 0, phase: 'idle', msg: 'Simulated autonomous survey on standby. Nothing moves until a named operator arms it.' }],
  };
}

export function armMission(s: MissionState, operator: string): MissionState {
  const op = operator.trim();
  if (s.phase !== 'idle') return withLog(s, `Arm ignored: survey is already ${s.phase}.`);
  if (!op) return withLog(s, 'Arm refused: a named human operator must arm the survey.');
  return withLog({ ...s, phase: 'armed', operator: op, phaseS: 0 },
    `Armed by ${op}. Pre-flight checks: geofence loaded, risk limit and auto return-to-home active.`, 'armed');
}

export function abortMission(s: MissionState): MissionState {
  const who = s.operator ?? 'operator';
  if (s.phase === 'idle' || s.phase === 'complete' || s.phase === 'aborted') return s;
  if (s.phase === 'armed') return withLog({ ...s, phase: 'aborted', aborted: true, plan: [] }, `Aborted by ${who} before launch. Drone stays at home base.`, 'aborted');
  if (s.phase === 'returning') return s.aborted ? s : withLog({ ...s, aborted: true }, `Abort by ${who}: already returning to home base.`);
  return withLog({ ...s, phase: 'returning', aborted: true, plan: [{ ...s.flown[0] }], phaseS: 0 },
    `ABORT by ${who}: survey stopped, returning to home base now.`, 'returning');
}

export function stepMission(s0: MissionState, dtS: number, cfg: MissionConfig, ctx: MissionContext): MissionState {
  if (!isActive(s0.phase) || !(dtS > 0)) return s0;
  const info = priorInfo(ctx.prior, cfg);
  let s: MissionState = s0;
  let covered: Float32Array | null = null; // copied on first write so the input state stays untouched
  let rem = Math.min(dtS, 600);
  const heatTick = Math.floor(s0.clockS / HEAT_REFRESH_S);

  const tick = (dt: number) => {
    s = { ...s, clockS: s.clockS + dt, phaseS: s.phaseS + dt, battery: isAirborne(s.phase) ? Math.max(0, s.battery - dt / cfg.enduranceS) : s.battery };
  };
  const go = (phase: MissionPhase, msg: string, extra: Partial<MissionState> = {}) => {
    s = withLog({ ...s, ...extra, phase, phaseS: 0 }, msg, phase);
  };
  const goHome = (why: string) => go('returning', `${why} Returning to home base ${km(dist(s.pos, cfg.home))} away.`, { plan: [{ ...cfg.home }] });
  const remap = () => { s = { ...s, uncertainty: uncertaintyOf(s.covered, info, cfg), coverage: coverageOf(s.covered, info) }; };

  for (let guard = 0; rem > 1e-9 && guard < 400; guard++) {
    const ph = s.phase;
    if (ph === 'armed' || ph === 'mapping' || ph === 'planning' || ph === 'updating') {
      const take = Math.min(rem, Math.max(0, DWELL[ph] - s.phaseS));
      tick(take);
      rem -= take;
      if (s.phaseS + 1e-9 < DWELL[ph]) break;
      if (ph === 'armed') {
        go('mapping', `Launched to ${cfg.altitudeAglM} m AGL. Mapping: building value map from enemy-origin prior and unknown ground.`);
      } else if (ph === 'mapping') {
        remap();
        const unknown = info.valuable.reduce((n, i) => n + (s.covered[i] < 0.5 ? 1 : 0), 0);
        go('planning', `Value map ready: ${(unknown / 100).toFixed(1)} sq km of high-value ground still unknown. Planning next leg.`);
      } else if (ph === 'planning') {
        const r = planNext(s, cfg, info, ctx.threat);
        if (!r) {
          const energyBound = (s.battery * cfg.enduranceS - RESERVE_S) * cfg.speedMs < dist(s.pos, cfg.home) + MIN_LEG * 2;
          goHome(energyBound ? `Battery ${pct(s.battery)}: no further leg fits with the return reserve.` : 'No safe, worthwhile leg left inside the geofence and risk limit.');
        } else {
          const f = r.first;
          const share = r.total > 0 ? Math.min(1, f.gain / r.total) : 0;
          const rej = r.rejectedRisk ? ` ${r.rejectedRisk} candidate leg${r.rejectedRisk === 1 ? '' : 's'} rejected over the ${pct(cfg.maxRisk)} risk limit.` : '';
          s = withLog(s, `Plan leg ${s.legs + 1}: ${km(f.len)} to ${at10(f.to)}, sweeps ~${pct(share)} of remaining survey value, peak threat ${pct(f.maxThreat)}.${rej}`);
          go('flying', `Flying leg ${s.legs + 1} at ${cfg.speedMs} m/s, camera mapping a ${km(cfg.footprintM * 2)} swath.`,
            { plan: r.plan, legStartS: s.clockS, legStartCoverage: s.coverage });
        }
      } else {
        remap();
        const newFinds = s.findings.filter((f) => f.t >= s.legStartS).length;
        const gain = s.coverage - s.legStartCoverage;
        s = withLog(s, `Update after leg ${s.legs}: high-value area ${pct(s.coverage)} mapped (+${pct(Math.max(0, gain))}), ${newFinds ? `${newFinds} new finding${newFinds > 1 ? 's' : ''}` : 'no new findings'}. Value map recomputed.`);
        if (s.coverage >= GOAL) goHome(`Survey goal met: ${pct(s.coverage)} of the high-value area mapped.`);
        else go('planning', 'Replanning from the updated value map.');
      }
      continue;
    }

    // flying / returning: move toward the next waypoint in substeps, mapping and looking as we go
    const wp = ph === 'returning' ? cfg.home : s.plan[0];
    if (!wp) { go('planning', 'No waypoint loaded. Replanning.'); continue; }
    const d = dist(s.pos, wp);
    const take = Math.min(rem, SUBSTEP_S, d / cfg.speedMs);
    const step = Math.min(d, cfg.speedMs * take);
    const pos = d > 1e-6 ? { x: s.pos.x + ((wp.x - s.pos.x) * step) / d, y: s.pos.y + ((wp.y - s.pos.y) * step) / d } : { ...wp };
    tick(take);
    rem -= take;
    covered ??= s.covered.slice();
    markDisc(covered, pos.x, pos.y, cfg.footprintM);
    const last = s.flown[s.flown.length - 1];
    const arrived = dist(pos, wp) <= ARRIVE_M;
    s = {
      ...s, pos, covered, risk: sample(ctx.threat, pos.x, pos.y),
      headingDeg: step > 0.01 ? compass(wp.x - s.pos.x, wp.y - s.pos.y) : s.headingDeg,
      flown: !last || dist(last, pos) >= BREADCRUMB_M || arrived ? [...s.flown, pos] : s.flown,
    };
    s = look(s, ctx, cfg);

    if (arrived) {
      if (ph === 'returning') {
        remap();
        const n = s.findings.length;
        const tail = `${pct(s.coverage)} of high-value area mapped, ${n} finding${n === 1 ? '' : 's'} for operator review.`;
        if (s.aborted) go('aborted', `Landed at home base after operator abort. ${tail}`, { plan: [] });
        else go('complete', `Landed at home base. Survey complete: ${tail}`, { plan: [] });
        rem = 0;
      } else {
        go('updating', `Leg ${s.legs + 1} complete. Updating map with new imagery.`, { legs: s.legs + 1, plan: s.plan.slice(1) });
      }
      continue;
    }
    if (ph === 'flying') {
      if (s.risk > cfg.maxRisk) goHome(`Threat at drone ${pct(s.risk)} exceeds the ${pct(cfg.maxRisk)} limit: automatic return-to-home.`);
      else if (s.battery * cfg.enduranceS <= dist(pos, cfg.home) / cfg.speedMs + RESERVE_S) goHome(`Battery ${pct(s.battery)} at return reserve: automatic return-to-home.`);
    }
  }

  if (covered) {
    s = { ...s, coverage: coverageOf(s.covered, info) };
    if (Math.floor(s.clockS / HEAT_REFRESH_S) !== heatTick && s.phase !== 'updating' && s.phase !== 'mapping') remap();
  }
  return s;
}

// Camera check at the current position: an origin estimate inside the footprint becomes a confirmed launch site
// (once per site), a hostile track inside it becomes a sighting (at most once a minute per track).
function look(s: MissionState, ctx: MissionContext, cfg: MissionConfig): MissionState {
  let out = s;
  for (const o of ctx.origins) {
    if (o.confidence < SITE_MIN_CONF || dist(s.pos, o.peak) > cfg.footprintM) continue;
    if (out.findings.some((f) => f.kind === 'launch_site' && (f.ref === o.track_id || dist(f, o.peak) < SITE_DEDUPE_M))) continue;
    const f: Finding = { kind: 'launch_site', x: o.peak.x, y: o.peak.y, t: s.clockS, ref: o.track_id, confidence: o.confidence };
    out = withLog({ ...out, findings: [...out.findings, f] },
      `Launch site confirmed in imagery near ${at10(o.peak)} (origin estimate for ${o.track_id}, ${pct(o.confidence)}). Flagged for operator review.`);
  }
  for (const tr of ctx.tracks) {
    if (dist(s.pos, tr.current) > cfg.footprintM) continue;
    const prev = out.findings.filter((f) => f.kind === 'hostile_drone' && f.ref === tr.id).pop();
    if (prev && s.clockS - prev.t < SIGHTING_GAP_S) continue;
    const conf = Math.round((1 - 0.4 * (dist(s.pos, tr.current) / cfg.footprintM)) * 100) / 100;
    const f: Finding = { kind: 'hostile_drone', x: tr.current.x, y: tr.current.y, t: s.clockS, ref: tr.id, confidence: conf };
    out = withLog({ ...out, findings: [...out.findings, f] },
      `Hostile drone ${tr.id} sighted at ${at10(tr.current)}. Position reported to operator.`);
  }
  return out;
}

// For the draped heat in this tab: red = high-value ground not yet mapped, faint blue = unknown, clear = mapped.
export function uncertaintyGrid(s: MissionState): Grid {
  return s.uncertainty;
}

// ---- deck.gl ----
type RGBA = [number, number, number, number];
const C = { allied: [90, 169, 255], friendly: [238, 234, 226], hostile: [240, 51, 43], origin: [255, 176, 46], ink: [18, 17, 16] } as const;
const rgba = (c: readonly number[], a = 255): RGBA => [c[0], c[1], c[2], a];
const FONT = '"JetBrains Mono", ui-monospace, monospace';
const PHASE_TAG: Record<MissionPhase, string> = {
  idle: 'STANDBY', armed: 'ARMED', mapping: 'MAPPING', planning: 'PLANNING', flying: 'FLYING', updating: 'UPDATING',
  returning: 'RTH', complete: 'COMPLETE', aborted: 'ABORTED',
};
export const phaseLabel = (p: MissionPhase) => PHASE_TAG[p];

const SURVEY_ICON = (() => {
  const c = '#eeeae2', r = '#5aa9ff';
  const rotors = [[-11, -11], [11, -11], [-11, 11], [11, 11]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7.5" fill="#121110" fill-opacity="0.6" stroke="${r}" stroke-width="1.8"/>
      <line x1="${x - 6}" y1="${y - 2}" x2="${x + 6}" y2="${y + 2}" stroke="${r}" stroke-width="2.2"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-24 -24 48 48">
    <path d="M-11 -11 L11 11 M11 -11 L-11 11" stroke="#121110" stroke-width="6"/>
    <path d="M-11 -11 L11 11 M11 -11 L-11 11" stroke="${c}" stroke-width="3"/>${rotors}
    <rect x="-5" y="-6" width="10" height="12" fill="${c}" stroke="#121110" stroke-width="1.5"/>
    <path d="M0 -15 L-4.5 -8 L4.5 -8 Z" fill="${c}" stroke="#121110" stroke-width="1"/></svg>`;
  return { id: 'mission-quad', url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 96, height: 96, anchorX: 48, anchorY: 48 };
})();

type V3 = [number, number, number];
type At = (x: number, y: number, up?: number) => V3;

function densify(pts: Point[], at: At, up: number, stepM = 200): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(dist(a, b) / stepM));
    for (let k = 0; k < n; k++) out.push(at(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, up));
  }
  const z = pts[pts.length - 1];
  if (z) out.push(at(z.x, z.y, up));
  return out;
}
function ring(x: number, y: number, r: number, at: At, up: number, n = 56): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) { const a = (2 * Math.PI * i) / n; out.push(at(x + r * Math.cos(a), y + r * Math.sin(a), up)); }
  return out;
}

// Survey drone, flown path, planned legs, camera footprint, geofence, home and findings. Ids are prefixed 'mission-'.
// `bearing` (map bearing in degrees) keeps the icon's nose on its heading when the camera is rotated.
export function missionLayers(s: MissionState, at: At, cfg: MissionConfig, opts: { bearing?: number } = {}): Layer[] {
  const out: Layer[] = [];
  const air = isAirborne(s.phase);
  const alt = air ? cfg.altitudeAglM : 4;
  const path = (id: string, paths: V3[][], color: RGBA, width: number) => new PathLayer<V3[]>({
    id, data: paths, getPath: (d) => d, getColor: color, getWidth: width, widthUnits: 'pixels', billboard: true, jointRounded: true, capRounded: true, pickable: false,
  });
  const text = (id: string, data: { p: V3; label: string; color: RGBA }[], offset: [number, number] = [0, 0], anchor: 'start' | 'middle' = 'middle') => new TextLayer<{ p: V3; label: string; color: RGBA }>({
    id, data, getPosition: (d) => d.p, getText: (d) => d.label, getColor: (d) => d.color, fontFamily: FONT, fontWeight: 700, characterSet: 'auto',
    sizeUnits: 'pixels', getSize: 13, background: true, getBackgroundColor: [18, 17, 16, 220], backgroundPadding: [6, 3], billboard: true,
    getPixelOffset: offset, getTextAnchor: anchor, getAlignmentBaseline: 'center', pickable: false,
  });

  const g = cfg.geofence;
  const fence = [{ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y0 }, { x: g.x1, y: g.y1 }, { x: g.x0, y: g.y1 }, { x: g.x0, y: g.y0 }];
  out.push(path('mission-geofence', [densify(fence, at, 25, 250)], rgba(C.allied, 150), 2));
  out.push(text('mission-geofence-label', [{ p: at(g.x0, g.y1, 60), label: 'GEOFENCE', color: rgba(C.allied) }], [0, -14], 'start'));

  out.push(new ScatterplotLayer<{ p: V3 }>({
    id: 'mission-home', data: [{ p: at(cfg.home.x, cfg.home.y, 3) }], getPosition: (d) => d.p, getRadius: 120, radiusUnits: 'meters',
    stroked: true, filled: true, getFillColor: rgba(C.ink, 120), getLineColor: rgba(C.allied, 230), lineWidthUnits: 'pixels', getLineWidth: 2, pickable: false,
  }));
  out.push(text('mission-home-label', [{ p: at(cfg.home.x, cfg.home.y, 40), label: 'HOME', color: rgba(C.allied) }], [0, 18]));

  if (s.flown.length > 1) out.push(path('mission-flown', [[...s.flown, s.pos].map((q) => at(q.x, q.y, cfg.altitudeAglM))], rgba(C.allied, 235), 3));
  if (air && s.plan.length) {
    out.push(path('mission-plan', [[s.pos, ...s.plan].map((q) => at(q.x, q.y, cfg.altitudeAglM))], rgba(C.friendly, 130), 2));
    out.push(new ScatterplotLayer<{ p: V3; i: number }>({
      id: 'mission-waypoints', data: s.plan.map((q, i) => ({ p: at(q.x, q.y, cfg.altitudeAglM), i })), getPosition: (d) => d.p,
      getRadius: (d) => (d.i === 0 ? 6 : 4), radiusUnits: 'pixels', stroked: true, filled: true,
      getFillColor: (d) => (d.i === 0 ? rgba(C.friendly, 230) : rgba(C.ink, 200)), getLineColor: rgba(C.friendly, 200), lineWidthUnits: 'pixels', getLineWidth: 1.5, pickable: false,
    }));
  }
  if (air) out.push(path('mission-footprint', [ring(s.pos.x, s.pos.y, cfg.footprintM, at, 8)], rgba(C.allied, 210), 2));

  // findings: one marker per site, the latest sighting per hostile track
  const latest = new Map<string, Finding>();
  for (const f of s.findings) latest.set(`${f.kind}:${f.kind === 'launch_site' ? `${r10(f.x)},${r10(f.y)}` : f.ref}`, f);
  const finds = [...latest.values()];
  if (finds.length) {
    const col = (f: Finding) => (f.kind === 'launch_site' ? rgba(C.origin) : rgba(C.hostile));
    out.push(new ScatterplotLayer<Finding>({
      id: 'mission-findings', data: finds, getPosition: (f) => at(f.x, f.y, 6), getRadius: (f) => (f.kind === 'launch_site' ? 160 : 90), radiusUnits: 'meters',
      stroked: true, filled: true, getFillColor: (f) => [...col(f).slice(0, 3), 60] as RGBA, getLineColor: col, lineWidthUnits: 'pixels', getLineWidth: 2, pickable: false,
    }));
    out.push(new LineLayer<Finding>({
      id: 'mission-finding-stalks', data: finds, getSourcePosition: (f) => at(f.x, f.y), getTargetPosition: (f) => at(f.x, f.y, 200),
      getColor: col, widthUnits: 'pixels', getWidth: 1.5, pickable: false,
    }));
    out.push(text('mission-finding-labels', finds.map((f) => ({
      p: at(f.x, f.y, 220), color: col(f), label: f.kind === 'launch_site' ? 'SITE CONFIRMED' : `HOSTILE SIGHTED ${f.ref}`,
    }))));
  }

  const drone = [{ p: at(s.pos.x, s.pos.y, alt), g: at(s.pos.x, s.pos.y) }];
  if (air) {
    out.push(new LineLayer<{ p: V3; g: V3 }>({
      id: 'mission-drop', data: drone, getSourcePosition: (d) => d.p, getTargetPosition: (d) => d.g, getColor: rgba(C.allied, 170), widthUnits: 'pixels', getWidth: 1.5, pickable: false,
    }));
  }
  const bearing = opts.bearing ?? 0;
  out.push(new IconLayer<{ p: V3 }>({
    id: 'mission-drone', data: drone, getPosition: (d) => d.p, getIcon: () => SURVEY_ICON, getSize: 52, sizeUnits: 'pixels', billboard: true,
    getAngle: () => bearing - s.headingDeg, updateTriggers: { getAngle: [bearing, s.headingDeg] }, pickable: false,
  }));
  out.push(text('mission-drone-label', [{ p: drone[0].p, color: rgba(C.allied), label: `SURVEY-1 · ${PHASE_TAG[s.phase]} · BAT ${pct(s.battery)}` }], [36, 0], 'start'));
  return out;
}
