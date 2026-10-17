// Backtracking view helpers: rays from each drone's first detection back to its estimated launch site, and how big the
// remaining search area is. Everything is derived from Frame fields (tracks, origins); see analysis/origin.py.
import type { LatLngExpression } from 'leaflet';
import { ll } from './geo';
import type { Frame, OriginEstimate, Point, Track } from './types';

// analysis/origin.py: a lone ray is capped at 0.6 confidence; 3+ agreeing rays score higher.
export const TRIANGULATED_AT = 0.7;
const CONE_M = 2000; // how far back an unconfirmed direction is drawn (origin.RAY_SMEAR_M)
const CONE_HALF_DEG = 12;

export type Site = { key: string; peak: Point; radius_m: number; confidence: number; trackIds: string[] };

export const isTriangulated = (o: OriginEstimate) => o.confidence >= TRIANGULATED_AT;

// Unit vector pointing back along the track, from a fit over its earliest points.
export function backHeading(tr: Track): Point | null {
  const pts = tr.points.slice(0, 30);
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = a.x - b.x, dy = a.y - b.y, n = Math.hypot(dx, dy);
  return n < 1 ? null : { x: dx / n, y: dy / n };
}

// Wedge behind the first detection: the launch is somewhere inside it, range unknown.
export function conePoints(tr: Track): { apex: Point; left: Point; mid: Point; right: Point } | null {
  const h = backHeading(tr);
  if (!h) return null;
  const p = tr.points[0];
  const at = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    const ux = h.x * Math.cos(r) - h.y * Math.sin(r), uy = h.x * Math.sin(r) + h.y * Math.cos(r);
    return { x: p.x + ux * CONE_M, y: p.y + uy * CONE_M };
  };
  return { apex: { x: p.x, y: p.y }, left: at(CONE_HALF_DEG), mid: at(0), right: at(-CONE_HALF_DEG) };
}

export function conePolygon(tr: Track): LatLngExpression[] | null {
  const c = conePoints(tr);
  return c ? [c.apex, c.left, c.mid, c.right].map((q) => ll(q.x, q.y)) : null;
}

// Triangulated origins that share a peak are one launch site.
export function sitesOf(frame: Frame | undefined): Site[] {
  const sites = new Map<string, Site>();
  for (const o of frame?.origins ?? []) {
    if (!isTriangulated(o)) continue;
    const key = `${Math.round(o.peak.x)},${Math.round(o.peak.y)}`;
    const s = sites.get(key) ?? { key, peak: o.peak, radius_m: o.radius_m, confidence: o.confidence, trackIds: [] };
    s.trackIds.push(o.track_id);
    sites.set(key, s);
  }
  return [...sites.values()];
}

const CONE_KM2 = (Math.PI * (2 * CONE_HALF_DEG) / 360) * (CONE_M / 1000) ** 2;

// km² still to search: each located site's circle plus a wedge for every drone whose direction alone is known.
export function searchAreaKm2(frame: Frame | undefined): number {
  if (!frame) return 0;
  const sites = sitesOf(frame).reduce((a, s) => a + Math.PI * (s.radius_m / 1000) ** 2, 0);
  const lone = frame.origins.filter((o) => !isTriangulated(o)).length;
  return sites + lone * CONE_KM2;
}
