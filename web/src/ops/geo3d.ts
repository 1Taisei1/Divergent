// Puts the simulated 10 km box on real terrain and samples that terrain's height for 3D objects.
// The simulation itself is terrain-agnostic (flat meters); this only decides where the box is drawn.
import { MAP_SIZE } from '../geo';
import type { Point } from '../types';

// South-west corner of the box: open desert ranges of the US Army National Training Center (Fort Irwin, CA),
// east of the garrison. 867 m of relief across the box, which reads well in 3D.
export const ORIGIN = { lat: 35.28, lon: -116.6 };
export const EXAGGERATION = 1.4; // terrain height multiplier, shared by MapLibre terrain and deck.gl objects
export const DEM_ZOOM = 12; // MapLibre's DEM source is capped here too, so both sample the same tiles
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const HOME_BASE: Point = { x: 8500, y: 1000 }; // sim/generate.py home_base (not in the Scenario payload)

const M_LAT = 111320;
const M_LON = M_LAT * Math.cos(((ORIGIN.lat + MAP_SIZE / 2 / M_LAT) * Math.PI) / 180);

export const toLngLat = (x: number, y: number): [number, number] => [ORIGIN.lon + x / M_LON, ORIGIN.lat + y / M_LAT];
export const fromLngLat = (lng: number, lat: number): Point => ({ x: (lng - ORIGIN.lon) * M_LON, y: (lat - ORIGIN.lat) * M_LAT });
export const clampToBox = (p: Point): Point => ({ x: Math.min(MAP_SIZE, Math.max(0, p.x)), y: Math.min(MAP_SIZE, Math.max(0, p.y)) });

// Corners for MapLibre image sources: top-left, top-right, bottom-right, bottom-left.
export const BOX_CORNERS: [[number, number], [number, number], [number, number], [number, number]] = [
  toLngLat(0, MAP_SIZE), toLngLat(MAP_SIZE, MAP_SIZE), toLngLat(MAP_SIZE, 0), toLngLat(0, 0),
];
export const BOX_BOUNDS: [[number, number], [number, number]] = [toLngLat(0, 0), toLngLat(MAP_SIZE, MAP_SIZE)];

// Ring of n points around (x, y), in lng/lat, for draped circles.
export function circleRing(x: number, y: number, r: number, n = 72): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push(toLngLat(x + r * Math.cos(a), y + r * Math.sin(a)));
  }
  return ring;
}

function tileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

// Sim meters → terrain height in meters, already exaggerated (what MapLibre draws).
export type ElevationFn = (x: number, y: number) => number;
export const flatElevation: ElevationFn = () => 0;

async function decodeTile(url: string): Promise<Float32Array> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return out;
}

// Loads the DEM tiles under the box once (4-6 tiles) and returns a bilinear sampler.
export async function loadElevation(): Promise<ElevationFn> {
  const [ax, ay] = tileXY(...toLngLat(0, 0), DEM_ZOOM);
  const [bx, by] = tileXY(...toLngLat(MAP_SIZE, MAP_SIZE), DEM_ZOOM);
  const tiles = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let tx = Math.floor(Math.min(ax, bx)); tx <= Math.floor(Math.max(ax, bx)); tx++) {
    for (let ty = Math.floor(Math.min(ay, by)); ty <= Math.floor(Math.max(ay, by)); ty++) {
      const url = DEM_URL.replace('{z}', String(DEM_ZOOM)).replace('{x}', String(tx)).replace('{y}', String(ty));
      jobs.push(decodeTile(url).then((d) => { tiles.set(`${tx}/${ty}`, d); }));
    }
  }
  await Promise.all(jobs);

  const at = (gx: number, gy: number) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const d = tiles.get(`${tx}/${ty}`);
    if (!d) return 0;
    const ix = Math.min(255, Math.max(0, gx - tx * 256)), iy = Math.min(255, Math.max(0, gy - ty * 256));
    return d[iy * 256 + ix];
  };
  return (x, y) => {
    const [fx, fy] = tileXY(...toLngLat(x, y), DEM_ZOOM);
    const gx = fx * 256 - 0.5, gy = fy * 256 - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), kx = gx - x0, ky = gy - y0;
    const top = at(x0, y0) * (1 - kx) + at(x0 + 1, y0) * kx;
    const bottom = at(x0, y0 + 1) * (1 - kx) + at(x0 + 1, y0 + 1) * kx;
    return (top * (1 - ky) + bottom * ky) * EXAGGERATION;
  };
}
