// Safest-path planner for the Route tab: A* over the 100 m threat grid (enemy sensor exposure plus expected
// launch areas), then up to two alternatives that are pushed away from the routes already found.
// Decision support on simulated data; the operator picks a route, nothing moves on its own.
import type { Grid, Point } from '../types';

export const THREAT_WEIGHT = 25; // a fully exposed cell costs 26x a clear one
const ALT_PENALTY = 6; // extra cost on cells near an earlier route, so alternatives diverge
const ALT_RADIUS_CELLS = 3;
const SIMPLIFY_M = 80;

export interface PlannedRoute {
  id: string; // A, B, C in order of planner cost (A = recommended)
  points: Point[];
  length_m: number;
  exposure_m: number; // integrated threat x distance: "metres flown fully exposed"
  max_threat: number; // peak threat on the route, 0..1
  cost: number; // the planner's own score: distance x (1 + THREAT_WEIGHT x threat)
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

class MinHeap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(item: [number, number]) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function astar(cost: Float32Array, W: number, H: number, s: number, g: number): number[] | null {
  const gScore = new Float32Array(W * H).fill(Infinity);
  const from = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const gx = g % W, gy = Math.floor(g / W);
  const h = (i: number) => Math.hypot((i % W) - gx, Math.floor(i / W) - gy); // min step cost is 1 → admissible
  const open = new MinHeap();
  gScore[s] = 0;
  open.push([h(s), s]);
  while (open.size) {
    const [, cur] = open.pop();
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W, cy = Math.floor(cur / W);
    for (const [dx, dy, len] of NEIGHBOURS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (closed[n]) continue;
      const tentative = gScore[cur] + len * (cost[cur] + cost[n]) / 2;
      if (tentative < gScore[n]) {
        gScore[n] = tentative;
        from[n] = cur;
        open.push([tentative + h(n), n]);
      }
    }
  }
  if (from[g] === -1 && s !== g) return null;
  const path = [g];
  while (path[path.length - 1] !== s) path.push(from[path[path.length - 1]]);
  return path.reverse();
}

// Ramer–Douglas–Peucker on sim-meter points.
function simplify(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * (pts[i].x - a.x) - dx * (pts[i].y - a.y)) / len;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

export function threatAt(threat: Grid, p: Point): number {
  const col = Math.min(threat.width - 1, Math.max(0, Math.floor(p.x / threat.cell_m)));
  const row = Math.min(threat.height - 1, Math.max(0, Math.floor(p.y / threat.cell_m)));
  return threat.values[row]?.[col] ?? 0;
}

function stats(threat: Grid, pts: Point[]) {
  let length = 0, exposure = 0, max = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    length += seg;
    const steps = Math.max(1, Math.ceil(seg / 50));
    for (let k = 0; k < steps; k++) {
      const v = threatAt(threat, { x: a.x + ((b.x - a.x) * (k + 0.5)) / steps, y: a.y + ((b.y - a.y) * (k + 0.5)) / steps });
      exposure += (v * seg) / steps;
      max = Math.max(max, v);
    }
  }
  return { length_m: length, exposure_m: exposure, max_threat: max, cost: length + THREAT_WEIGHT * exposure };
}

export function planRoutes(threat: Grid, start: Point, goal: Point, count = 3): PlannedRoute[] {
  const { width: W, height: H, cell_m: cell } = threat;
  const base = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) base[r * W + c] = 1 + THREAT_WEIGHT * (threat.values[r]?.[c] ?? 0);
  const idx = (p: Point) => Math.min(H - 1, Math.max(0, Math.floor(p.y / cell))) * W + Math.min(W - 1, Math.max(0, Math.floor(p.x / cell)));
  const s = idx(start), g = idx(goal);
  const cost = base.slice();
  const routes: PlannedRoute[] = [];
  const used: Set<number>[] = [];

  for (let k = 0; k < count + 2 && routes.length < count; k++) {
    const cells = astar(cost, W, H, s, g);
    if (!cells) break;
    const set = new Set(cells);
    const overlap = used.length ? Math.max(...used.map((u) => cells.filter((c) => u.has(c)).length / cells.length)) : 0;
    // Push later searches away from this corridor whether or not we keep it (each nearby cell penalised once).
    const corridor = new Set<number>();
    for (const c of cells) {
      const cx = c % W, cy = Math.floor(c / W);
      for (let dy = -ALT_RADIUS_CELLS; dy <= ALT_RADIUS_CELLS; dy++) {
        for (let dx = -ALT_RADIUS_CELLS; dx <= ALT_RADIUS_CELLS; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && dx * dx + dy * dy <= ALT_RADIUS_CELLS ** 2) corridor.add(ny * W + nx);
        }
      }
    }
    for (const c of corridor) cost[c] += ALT_PENALTY;
    if (overlap > 0.7) continue; // too close to a route we already have
    used.push(set);
    const centres = cells.map((c) => ({ x: ((c % W) + 0.5) * cell, y: (Math.floor(c / W) + 0.5) * cell }));
    const pts = simplify([start, ...centres.slice(1, -1), goal], SIMPLIFY_M);
    routes.push({ id: '', points: pts, ...stats(threat, pts) });
  }
  // Rank by the planner's own cost and letter after sorting, so A is always the recommendation.
  return routes.sort((a, b) => a.cost - b.cost).map((r, i) => ({ ...r, id: String.fromCharCode(65 + i) }));
}
