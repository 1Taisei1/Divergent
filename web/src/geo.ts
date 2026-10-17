// Map helpers. Leaflet CRS.Simple takes [lat, lng] = [y, x], 1 unit = 1 meter.
import type { LatLngExpression, LatLngTuple } from 'leaflet';
import type { Grid, MaybeGrid, Point, Track } from './types';
import { isGrid } from './types';

export const MAP_SIZE = 10000;
export const ll = (x: number, y: number): LatLngTuple => [y, x];
export const llp = (p: Point): LatLngTuple => [p.y, p.x];

// Track uncertainty ellipse as a polygon. angle_deg is measured counter-clockwise from east (x axis).
export function ellipsePolygon(t: Track, n = 36): LatLngExpression[] {
  const { major_m: a, minor_m: b, angle_deg } = t.ellipse;
  const th = (angle_deg * Math.PI) / 180;
  const pts: LatLngExpression[] = [];
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * i) / n;
    const x = t.current.x + a * Math.cos(ph) * Math.cos(th) - b * Math.sin(ph) * Math.sin(th);
    const y = t.current.y + a * Math.cos(ph) * Math.sin(th) + b * Math.sin(ph) * Math.cos(th);
    pts.push(ll(x, y));
  }
  return pts;
}

// Small triangle pointing from a to b, placed at b.
export function arrowHead(a: Point, b: Point, size = 220): LatLngExpression[] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const wing = (s: number) => ll(b.x - size * Math.cos(ang + s), b.y - size * Math.sin(ang + s));
  return [ll(b.x, b.y), wing(0.45), wing(-0.45)];
}

export type Ramp = (v: number) => [number, number, number, number];
const mix = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);

export const RAMPS: Record<'origin' | 'exposure' | 'forecast', Ramp> = {
  // translucent orange → red
  origin: (v) => [mix(255, 235, v), mix(170, 30, v), mix(0, 30, v), v < 0.02 ? 0 : Math.round(255 * (0.15 + 0.6 * v))],
  exposure: (v) => [230, 40, 40, v < 0.02 ? 0 : Math.round(255 * 0.32 * v)],
  forecast: (v) => [mix(150, 190, v), mix(80, 110, v), 255, v < 0.02 ? 0 : Math.round(255 * (0.12 + 0.55 * v))],
};

const cache = new WeakMap<Grid, Map<Ramp, string>>();

// Grid → PNG data URL, one pixel per cell. Grid row 0 is the south edge, canvas row 0 is the top.
export function gridImage(g: Grid, ramp: Ramp): string {
  const hit = cache.get(g)?.get(ramp);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = g.width;
  c.height = g.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(g.width, g.height);
  for (let row = 0; row < g.height; row++) {
    for (let col = 0; col < g.width; col++) {
      const v = Math.max(0, Math.min(1, g.values[row]?.[col] ?? 0));
      const i = ((g.height - 1 - row) * g.width + col) * 4;
      const [r, gg, b, a] = ramp(v);
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL();
  if (!cache.has(g)) cache.set(g, new Map());
  cache.get(g)!.set(ramp, url);
  return url;
}

export const gridBounds = (g: Grid): [LatLngTuple, LatLngTuple] => [ll(0, 0), ll(g.width * g.cell_m, g.height * g.cell_m)];
export const hasHeat = (g: MaybeGrid | null | undefined): g is Grid => isGrid(g) && g.values.some((r) => r.some((v) => v > 0));

export const pct = (v: number) => `${Math.round(v * 100)}%`;
