// Survey -> every tab. What the autonomous survey has seen feeds back into the other pictures:
//  - Enemy origins: ground the camera mapped and found empty loses likelihood (negative information); a launch site the
//    survey confirmed becomes a hard peak.
//  - Safe launch: confirmed enemy sites push our launch options away (standoff); ground mapped clear is a bit safer.
//  - Route threat is built from the fused origin field, so routes re-plan around what the survey found.
// The survey itself plans from the enemy-origin field and flies under the route-threat limit, closing the loop.
// Pure functions on 100 x 100 grids (row 0 = south), cached per input identity.
import type { Grid } from '../types';
import type { Finding } from './autonomy';

const N = 100, CELL = 100;
export type SurveyEvidence = { covered: Float32Array; findings: Finding[]; key: unknown };

const sites = (f: Finding[]) => f.filter((x) => x.kind === 'launch_site');
const hasData = (ev: SurveyEvidence | null): ev is SurveyEvidence => !!ev && (ev.findings.length > 0 || ev.covered.some((v) => v > 0.05));

function mapGrid(g: Grid, fn: (v: number, x: number, y: number, i: number) => number): Grid {
  const values = g.values.map((row, r) => row.map((v, c) => fn(v, (c + 0.5) * g.cell_m, (r + 0.5) * g.cell_m, r * N + c)));
  return { ...g, values };
}

const originCache = new WeakMap<Grid, { key: unknown; out: Grid }>();
export function fuseOrigin(origin: Grid | null, ev: SurveyEvidence | null): Grid | null {
  if (!origin || !hasData(ev) || origin.cell_m !== CELL || origin.width !== N) return origin;
  const hit = originCache.get(origin);
  if (hit && hit.key === ev.key) return hit.out;
  const confirmed = sites(ev.findings);
  const out = mapGrid(origin, (v, x, y, i) => {
    let o = v * (1 - 0.8 * (ev.covered[i] ?? 0)); // mapped and nothing found there
    for (const s of confirmed) o = Math.max(o, Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * 260 * 260)));
    return o;
  });
  originCache.set(origin, { key: ev.key, out });
  return out;
}

const launchCache = new WeakMap<Grid, { key: unknown; out: Grid }>();
export function fuseLaunch(launch: Grid | null, ev: SurveyEvidence | null): Grid | null {
  if (!launch || !hasData(ev) || launch.cell_m !== CELL || launch.width !== N) return launch;
  const hit = launchCache.get(launch);
  if (hit && hit.key === ev.key) return hit.out;
  const confirmed = sites(ev.findings);
  const out = mapGrid(launch, (v, x, y, i) => {
    let o = v * (1 + 0.3 * (ev.covered[i] ?? 0)); // eyes-on clear ground
    for (const s of confirmed) o *= 1 - 0.9 * Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * 1300 * 1300));
    return Math.min(1, o);
  });
  launchCache.set(launch, { key: ev.key, out });
  return out;
}

// One line for each tab's legend: what the survey has contributed so far.
export function surveyNote(ev: SurveyEvidence | null, mappedShare: number): string {
  if (!hasData(ev)) return '';
  const n = sites(ev.findings).length, u = new Set(ev.findings.filter((f) => f.kind === 'hostile_drone').map((f) => f.ref)).size;
  return `+ SURVEY-1: ${Math.round(mappedShare * 100)}% of AO mapped · ${n} hostile site${n === 1 ? '' : 's'} · ${u} hostile UAS`;
}

export function mappedShare(covered: Float32Array): number {
  let s = 0;
  for (let i = 0; i < covered.length; i++) s += covered[i];
  return s / covered.length;
}
