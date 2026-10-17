// Sensor coverage for the 3D ops map, Lattice style: every active sensor is a translucent column of its detection range
// standing on the terrain, radar also gets a rotating vertical sweep fan, and a disabled sensor is only a dashed grey
// ground ring. Pure: returns deck.gl layers, and everything animated comes from opts.timeMs. All data is simulated.
import type { Layer } from '@deck.gl/core';
import { LineLayer, PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { Sensor, SensorType, Side } from '../types';

type Pos = [number, number, number];
type At = (x: number, y: number, up?: number) => Pos;
type RGBA = [number, number, number, number];
type Focus = 'allied' | 'enemy' | 'all';

const RGB = { allied: [90, 169, 255], enemy: [240, 51, 43], muted: [143, 138, 132] } as const;
const HEIGHT_M: Record<SensorType, number> = { radar: 350, acoustic: 200, rf: 250 };
const RING_SEGMENTS = 64; // vertices around each volume
const STRUT_STEP = 8; // a vertical strut on every 8th ring vertex
const OFF_SEGMENTS = 96; // ring vertices for a disabled sensor; 2 of every 4 segments are drawn, so it reads as dashed
const GROUND_LIFT_M = 8; // keeps ground edges clear of MapLibre's terrain mesh, which differs a little from our DEM samples
const FILL_ALPHA = 24, TOP_ALPHA = 140, BASE_ALPHA = 170, STRUT_ALPHA = 55, OFF_ALPHA = 150;
const UNFOCUSED = 0.35; // alpha multiplier for the side that is not in focus
const SWEEP_MS = 4000; // one full turn
const SWEEP_SLICE_RAD = (9 * Math.PI) / 180;
const SWEEP_ALPHAS = [70, 44, 24, 10]; // newest slice first: the fan fades out behind the leading edge
const SWEEP_EDGE_ALPHA = 210;
const SWEEP_RADIAL_STEPS = 6, SWEEP_ARC_STEPS = 4;
const NO_DEPTH_WRITE = { depthWriteEnabled: false }; // translucent shells must not hide each other or the labels behind them

type Prism = { side: Side; polygon: Pos[]; height: number; alpha: number }; // extruded: base on the ground, top at base + height
type Stroke = { side: Side; rgb: readonly number[]; path: Pos[]; alpha: number };
type Strut = { side: Side; from: Pos; to: Pos };
type Geometry = { volumes: Prism[]; outlines: Stroke[]; struts: Strut[]; off: Stroke[] };

const raised = (p: Pos, dz: number): Pos => [p[0], p[1], p[2] + dz];
// Point at `bearing` radians (0 = north, clockwise) and distance r from the sensor, on the terrain.
const ground = (s: Sensor, r: number, bearing: number, at: At, up = GROUND_LIFT_M) => at(s.x + r * Math.sin(bearing), s.y + r * Math.cos(bearing), up);

function build(sensors: Sensor[], at: At): Geometry {
  const g: Geometry = { volumes: [], outlines: [], struts: [], off: [] };
  for (const s of sensors) {
    if (!s.active) {
      const ring = Array.from({ length: OFF_SEGMENTS }, (_, i) => ground(s, s.range_m, (2 * Math.PI * i) / OFF_SEGMENTS, at));
      for (let i = 0; i < OFF_SEGMENTS; i += 4) g.off.push({ side: s.side, rgb: RGB.muted, path: [ring[i], ring[i + 1], ring[i + 2]], alpha: OFF_ALPHA });
      continue;
    }
    const height = HEIGHT_M[s.type];
    const base = Array.from({ length: RING_SEGMENTS }, (_, i) => ground(s, s.range_m, (2 * Math.PI * i) / RING_SEGMENTS, at));
    const top = base.map((p) => raised(p, height));
    g.volumes.push({ side: s.side, polygon: base, height, alpha: FILL_ALPHA });
    g.outlines.push(
      { side: s.side, rgb: RGB[s.side], path: [...base, base[0]], alpha: BASE_ALPHA },
      { side: s.side, rgb: RGB[s.side], path: [...top, top[0]], alpha: TOP_ALPHA },
    );
    for (let i = 0; i < RING_SEGMENTS; i += STRUT_STEP) g.struts.push({ side: s.side, from: base[i], to: top[i] });
  }
  return g;
}

// Volumes only depend on the sensors and the terrain, so keep them (and deck.gl's GPU buffers) between frames. The terrain
// is read off the sensors' ground height: it changes once, when the DEM loads and `at` stops returning sea level.
let memo: { key: string; geo: Geometry } | null = null;
function geometry(sensors: Sensor[], at: At): Geometry {
  const key = sensors.map((s) => `${s.id}|${s.side}|${s.type}|${s.x}|${s.y}|${s.range_m}|${s.active}|${Math.round(at(s.x, s.y)[2])}`).join(';');
  if (memo?.key !== key) memo = { key, geo: build(sensors, at) };
  return memo.geo;
}

// Rotating radar fan: a few thin vertical wedges trailing the leading edge, rebuilt every call because they move.
function sweeps(sensors: Sensor[], at: At, timeMs: number): { fan: Prism[]; edges: Stroke[] } {
  const fan: Prism[] = [], edges: Stroke[] = [];
  const lead = ((((timeMs % SWEEP_MS) + SWEEP_MS) % SWEEP_MS) / SWEEP_MS) * 2 * Math.PI;
  for (const s of sensors) {
    if (!s.active || s.type !== 'radar') continue;
    const height = HEIGHT_M.radar;
    const centre = at(s.x, s.y, GROUND_LIFT_M);
    // Outward point lists along the leading edge and each slice boundary behind it; the last point is the tip at full range.
    const spokes = Array.from({ length: SWEEP_ALPHAS.length + 1 }, (_, k) =>
      Array.from({ length: SWEEP_RADIAL_STEPS }, (_, j) => ground(s, (s.range_m * (j + 1)) / SWEEP_RADIAL_STEPS, lead - k * SWEEP_SLICE_RAD, at)));
    SWEEP_ALPHAS.forEach((alpha, k) => {
      const arc = Array.from({ length: SWEEP_ARC_STEPS - 1 }, (_, j) => ground(s, s.range_m, lead - k * SWEEP_SLICE_RAD - ((j + 1) * SWEEP_SLICE_RAD) / SWEEP_ARC_STEPS, at));
      fan.push({ side: s.side, polygon: [centre, ...spokes[k], ...arc, ...[...spokes[k + 1]].reverse()], height, alpha });
    });
    const floor = [centre, ...spokes[0]];
    const ceiling = floor.map((p) => raised(p, height)).reverse();
    edges.push({ side: s.side, rgb: RGB[s.side], path: [...floor, ...ceiling, centre], alpha: SWEEP_EDGE_ALPHA });
  }
  return { fan, edges };
}

export function coverageLayers(
  sensors: Sensor[],
  at: At, // sim meters -> [lng, lat, terrain z + up]
  opts: { focus: Focus; timeMs: number },
): Layer[] {
  const { focus, timeMs } = opts;
  const geo = geometry(sensors, at);
  const sweep = sweeps(sensors, at, timeMs);
  const color = (rgb: readonly number[], side: Side, alpha: number): RGBA =>
    [rgb[0], rgb[1], rgb[2], Math.round(alpha * (focus === 'all' || focus === side ? 1 : UNFOCUSED))];
  const common = { pickable: false, parameters: NO_DEPTH_WRITE };

  const prisms = (id: string, data: Prism[]) => new SolidPolygonLayer<Prism>({
    id, data, ...common, extruded: true, material: false, // unlit: shading would make the shells uneven
    getPolygon: (d) => d.polygon, getElevation: (d) => d.height, getFillColor: (d) => color(RGB[d.side], d.side, d.alpha),
    updateTriggers: { getFillColor: focus },
  });
  const strokes = (id: string, data: Stroke[], width: number) => new PathLayer<Stroke>({
    id, data, ...common, widthUnits: 'pixels', getWidth: width, billboard: true, capRounded: true, jointRounded: true,
    getPath: (d) => d.path, getColor: (d) => color(d.rgb, d.side, d.alpha), updateTriggers: { getColor: focus },
  });

  return [
    strokes('coverage-off-rings', geo.off, 1.2),
    prisms('coverage-volumes', geo.volumes),
    prisms('coverage-sweep-fan', sweep.fan),
    strokes('coverage-outlines', geo.outlines, 1.5),
    new LineLayer<Strut>({
      id: 'coverage-struts', data: geo.struts, ...common, widthUnits: 'pixels', getWidth: 1,
      getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.to, getColor: (d) => color(RGB[d.side], d.side, STRUT_ALPHA),
      updateTriggers: { getColor: focus },
    }),
    strokes('coverage-sweep-edge', sweep.edges, 2),
  ];
}
