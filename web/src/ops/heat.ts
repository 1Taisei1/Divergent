// Heat-map images: transparent at zero, then one colour family per meaning, so a colour never means two things.
// threat = amber → red (danger rises), safe = pale → deep green (safety rises), unknown = pale → amber (MIL-STD-2525
// "unknown" yellow). Single-hue ramps read as "more / less" at a glance; the old rainbow ramp made blue look important.
// Grids are bilinear-upsampled before colouring so blobs come out smooth instead of 100 m blocks.
import type { Grid, MaybeGrid } from '../types';
import { isGrid } from '../types';

type Stop = [number, number, number, number, number]; // value, r, g, b, alpha
export type Palette = 'threat' | 'safe' | 'unknown';
const PALETTES: Record<Palette, Stop[]> = {
  threat: [
    [0.0, 255, 200, 60, 0],
    [0.06, 255, 200, 60, 0], // faint tails stay invisible, then fade in, so blobs have soft edges instead of slabs
    [0.2, 255, 196, 56, 0.3],
    [0.45, 255, 150, 30, 0.5],
    [0.7, 245, 90, 25, 0.68],
    [1.0, 225, 30, 30, 0.84],
  ],
  safe: [
    [0.0, 150, 235, 170, 0],
    [0.06, 150, 235, 170, 0],
    [0.2, 150, 235, 170, 0.26],
    [0.45, 80, 214, 130, 0.45],
    [0.7, 40, 190, 105, 0.62],
    [1.0, 20, 160, 85, 0.8],
  ],
  unknown: [
    [0.0, 255, 236, 140, 0],
    [0.06, 255, 236, 140, 0],
    [0.2, 255, 236, 140, 0.24],
    [0.45, 255, 220, 90, 0.42],
    [0.7, 245, 200, 50, 0.58],
    [1.0, 230, 175, 20, 0.74],
  ],
};

// Discrete swatches for the legend (no CSS gradients in this UI).
export const legendSwatches = (p: Palette) => [0.2, 0.4, 0.6, 0.8, 0.95].map((v) => {
  const [r, g, b] = ramp(v, p);
  return `rgb(${r} ${g} ${b})`;
});

export function ramp(v: number, p: Palette = 'threat'): [number, number, number, number] {
  if (v <= 0.02) return [0, 0, 0, 0];
  const stops = PALETTES[p];
  for (let i = 1; i < stops.length; i++) {
    const [v1, r1, g1, b1, a1] = stops[i];
    if (v <= v1) {
      const [v0, r0, g0, b0, a0] = stops[i - 1];
      const k = (v - v0) / (v1 - v0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k, (a0 + (a1 - a0) * k) * 255];
    }
  }
  const [, r, g, b, a] = stops[stops.length - 1];
  return [r, g, b, a * 255];
}


export const hasValues = (g: MaybeGrid | null | undefined): g is Grid => isGrid(g) && g.values.some((r) => r.some((v) => v > 0.02));

// Display contrast: v^gamma (gamma < 1 lifts the weak-but-real evidence so the whole computed field reads, not just
// its peaks). Display only; analytics and routing use the raw field. Cached per grid.
const lifted = new WeakMap<Grid, Map<number, Grid>>();
export function lift(g: Grid, gamma: number): Grid {
  let byGamma = lifted.get(g);
  if (!byGamma) lifted.set(g, (byGamma = new Map()));
  const hit = byGamma.get(gamma);
  if (hit) return hit;
  const out = { ...g, values: g.values.map((row) => row.map((v) => (v > 0 ? v ** gamma : 0))) };
  byGamma.set(gamma, out);
  return out;
}

// Frames are reused by content: grids are often recomputed with identical values (same estimates, next second).
const byContent = new Map<string, HeatFrame>();
const MAX_FRAMES = 12;

// Cheap content key: FNV-1a over values quantized to 1/256 (what the 8-bit ramp can show anyway).
function contentKey(values: number[][], scale: number, size: number, spread: number, palette: Palette): string {
  let h = 0x811c9dc5;
  for (const row of values) {
    for (const v of row) {
      h ^= Math.round(Math.min(1, Math.max(0, v * scale)) * 255);
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${(h >>> 0).toString(36)}:${values.length}:${size}:${spread}:${palette}`;
}

// Separable Gaussian blur (sigma in cells), rescaled so the peak stays where it was. Display smoothing only.
function blur(values: number[][], sigma: number): number[][] {
  const r = Math.ceil(sigma * 2.5);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const H = values.length, W = values[0]?.length ?? 0;
  const pass = (src: number[][], horizontal: boolean) => src.map((row, y) => row.map((_, x) => {
    let s = 0;
    for (let i = -r; i <= r; i++) {
      const xx = horizontal ? Math.min(W - 1, Math.max(0, x + i)) : x, yy = horizontal ? y : Math.min(H - 1, Math.max(0, y + i));
      s += src[yy][xx] * k[i + r];
    }
    return s / ks;
  }));
  const out = pass(pass(values, true), false);
  const before = Math.max(...values.map((row) => Math.max(...row))), after = Math.max(...out.map((row) => Math.max(...row)));
  return after > 0 ? out.map((row) => row.map((v) => (v * before) / after)) : out;
}

// Grid (row 0 = south) → canvas (row 0 = north), values multiplied by `scale` and clipped to 0..1.
// `spread` (cells) softens small blobs so they read at overview zoom. `key` identifies the rendered contents, so
// callers (and the tile layer) skip all work when a recomputed grid would render identically.
export type HeatFrame = { key: string; canvas: HTMLCanvasElement };
export function heatFrame(g: Grid, palette: Palette = 'threat', scale = 1, size = 320, spread = 0): HeatFrame {
  const key = contentKey(g.values, scale, size, spread, palette);
  const hit = byContent.get(key);
  if (hit) return hit;
  const { width: W, height: H } = g;
  const values = spread > 0 ? blur(g.values, spread) : g.values;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const v = (r: number, col: number) => values[Math.min(H - 1, Math.max(0, r))]?.[Math.min(W - 1, Math.max(0, col))] ?? 0;
  for (let i = 0; i < size; i++) {
    const gy = ((size - 1 - i + 0.5) * H) / size - 0.5; // grid row, south-up
    const r0 = Math.floor(gy), ky = gy - r0;
    for (let j = 0; j < size; j++) {
      const gx = ((j + 0.5) * W) / size - 0.5;
      const c0 = Math.floor(gx), kx = gx - c0;
      const val = (v(r0, c0) * (1 - kx) + v(r0, c0 + 1) * kx) * (1 - ky) + (v(r0 + 1, c0) * (1 - kx) + v(r0 + 1, c0 + 1) * kx) * ky;
      const [r, gg, b, a] = ramp(Math.min(1, Math.max(0, val * scale)), palette);
      const o = (i * size + j) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const frame = { key, canvas: c };
  byContent.set(key, frame);
  if (byContent.size > MAX_FRAMES) byContent.delete(byContent.keys().next().value!);
  return frame;
}

// Survey-tab heat: what the drone has uploaded. Ground it has mapped shows the danger level it found there (red ramp)
// or green where it is clear; ground it has not mapped stays amber (unknown, by survey value). `mapped` is the
// mission's 100 x 100 coverage (row 0 = south, 0..1); the two pictures blend where the camera footprint fades out.
const CLEAR_BELOW = 0.2;
export function revealFrame(danger: Grid, unknown: Grid, mapped: Float32Array, size = 320): HeatFrame {
  let h = 0x811c9dc5;
  for (let i = 0; i < mapped.length; i += 3) { h ^= Math.round(mapped[i] * 15); h = Math.imul(h, 0x01000193); }
  const key = `reveal:${contentKey(danger.values, 1, size, 0, 'threat')}:${contentKey(unknown.values, 1, size, 0, 'unknown')}:${(h >>> 0).toString(36)}`;
  const hit = byContent.get(key);
  if (hit) return hit;
  const W = danger.width, H = danger.height, N = Math.round(Math.sqrt(mapped.length));
  const at = (vals: number[][], r: number, c: number) => vals[Math.min(H - 1, Math.max(0, r))]?.[Math.min(W - 1, Math.max(0, c))] ?? 0;
  const mAt = (r: number, c: number) => mapped[Math.min(N - 1, Math.max(0, r)) * N + Math.min(N - 1, Math.max(0, c))] ?? 0;
  const bil = (f: (r: number, c: number) => number, r0: number, c0: number, ky: number, kx: number) =>
    (f(r0, c0) * (1 - kx) + f(r0, c0 + 1) * kx) * (1 - ky) + (f(r0 + 1, c0) * (1 - kx) + f(r0 + 1, c0 + 1) * kx) * ky;
  const clear = ramp(0.32, 'safe');
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size; i++) {
    const gy = ((size - 1 - i + 0.5) * H) / size - 0.5;
    const r0 = Math.floor(gy), ky = gy - r0;
    for (let j = 0; j < size; j++) {
      const gx = ((j + 0.5) * W) / size - 0.5;
      const c0 = Math.floor(gx), kx = gx - c0;
      const m = Math.min(1, Math.max(0, bil(mAt, r0, c0, ky, kx)));
      const u = ramp(Math.min(1, Math.max(0, bil((r, col) => at(unknown.values, r, col), r0, c0, ky, kx))), 'unknown');
      let px = u;
      if (m > 0.02) {
        const d = Math.min(1, Math.max(0, bil((r, col) => at(danger.values, r, col), r0, c0, ky, kx)));
        const seen = d >= CLEAR_BELOW ? ramp(d, 'threat') : clear;
        px = [seen[0] * m + u[0] * (1 - m), seen[1] * m + u[1] * (1 - m), seen[2] * m + u[2] * (1 - m), seen[3] * m + u[3] * (1 - m)];
      }
      const o = (i * size + j) * 4;
      img.data[o] = px[0]; img.data[o + 1] = px[1]; img.data[o + 2] = px[2]; img.data[o + 3] = px[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const frame = { key, canvas: c };
  byContent.set(key, frame);
  if (byContent.size > MAX_FRAMES) byContent.delete(byContent.keys().next().value!);
  return frame;
}

// Enemy-tab heat: each origin estimate is a Gaussian (sigma = its uncertainty radius, at least MIN_SIGMA_M) whose height
// is its confidence, combined by max, so a site is as red as its most confident estimate (not as dense as its launches).
const MIN_SIGMA_M = 250;
export function confidenceGrid(origins: { peak: { x: number; y: number }; confidence: number; radius_m: number }[], cell = 100, n = 100): Grid {
  const values = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const o of origins) {
    const sigma = Math.max(MIN_SIGMA_M, o.radius_m);
    const reach = Math.ceil((3 * sigma) / cell);
    const c0 = Math.floor(o.peak.x / cell), r0 = Math.floor(o.peak.y / cell);
    for (let r = Math.max(0, r0 - reach); r <= Math.min(n - 1, r0 + reach); r++) {
      for (let c = Math.max(0, c0 - reach); c <= Math.min(n - 1, c0 + reach); c++) {
        const dx = (c + 0.5) * cell - o.peak.x, dy = (r + 0.5) * cell - o.peak.y;
        const v = o.confidence * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        if (v > values[r][c]) values[r][c] = v;
      }
    }
  }
  return { cell_m: cell, width: n, height: n, values };
}

// Element-wise a + w·b, clipped to 0..1 (for combined threat grids).
export function blend(a: Grid, b: MaybeGrid | null | undefined, w: number): Grid {
  if (!isGrid(b)) return a;
  return { ...a, values: a.values.map((row, r) => row.map((x, c) => Math.min(1, x + w * (b.values[r]?.[c] ?? 0)))) };
}
