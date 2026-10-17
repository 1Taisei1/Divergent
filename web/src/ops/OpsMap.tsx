// 3D operations map: satellite imagery on real terrain (MapLibre), one draped heat layer per tab, and deck.gl for
// the things that live in 3D (sensor masts, drone flight paths, survey drone). Inspired by Lattice / Gotham layouts,
// drawn in this project's tactical-telemetry style. All data is simulated; terrain placement is illustrative.
import type { Layer, PickingInfo } from '@deck.gl/core';
import { ColumnLayer, IconLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import maplibregl, { type GeoJSONSource, type ImageSource, type Map as MLMap, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { headingDeg, pad3, speedMs, STEP_MS } from '../drones';
import { MAP_SIZE, pct } from '../geo';
import { frameAt } from '../MapView';
import type { Detection, Grid, Point, ReconRoute, Scenario, Sensor, Track } from '../types';
import {
  BOX_BOUNDS, BOX_CORNERS, circleRing, clampToBox, DEM_URL, DEM_ZOOM, EXAGGERATION, flatElevation, fromLngLat, HOME_BASE,
  IMAGERY_URL, loadElevation, toLngLat, type ElevationFn,
} from './geo3d';
import { coverageLayers } from './coverage';
import { blend, confidenceGrid, EMPTY_IMAGE, hasValues, heatImage, LEGEND_SWATCHES } from './heat';
import { planRoutes } from './route';

export type OpsMode = 'enemy' | 'launch' | 'route';
const MODES: { id: OpsMode; label: string; red: string; low: string; high: string }[] = [
  { id: 'enemy', label: 'Enemy origins', red: 'Red = most confident enemy launch origin', low: 'Unlikely', high: 'Confident' },
  { id: 'launch', label: 'Safe launch', red: 'Red = safest place for us to launch from', low: 'Exposed', high: 'Safest' },
  { id: 'route', label: 'Route plan', red: 'Red = exposed to enemy sensors or launches', low: 'Clear', high: 'Exposed' },
];

type RGBA = [number, number, number, number];
const RGB = {
  hostile: [240, 51, 43], lost: [143, 138, 132], friendly: [238, 234, 226], allied: [90, 169, 255], enemy: [240, 51, 43],
  origin: [255, 176, 46], safe: [63, 214, 138], det: [127, 240, 255], clutter: [150, 150, 150], ink: [18, 17, 16],
} as const;
const rgba = (c: readonly number[], a = 255): RGBA => [c[0], c[1], c[2], a];
const FONT = '"JetBrains Mono", ui-monospace, monospace';
const SENSOR_CODE = { radar: 'RAD', acoustic: 'ACO', rf: 'RF' } as const;

// Display-only altitude: the simulation is 2D, so drones are drawn climbing from their first fix to a cruise height.
const CRUISE_AGL = 140, CLIMB_MS = 9, START_AGL = 20, SURVEY_AGL = 110;
const agl = (t: number, t0: number) => Math.min(CRUISE_AGL, START_AGL + CLIMB_MS * Math.max(0, t - t0));

type Kind = 'hostile' | 'lost' | 'friendly';
function quadIcon(kind: Kind) {
  const c = kind === 'hostile' ? '#f0332b' : kind === 'lost' ? '#8f8a84' : '#eeeae2';
  const r = kind === 'friendly' ? '#5aa9ff' : c;
  const rotors = [[-11, -11], [11, -11], [-11, 11], [11, 11]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7.5" fill="#121110" fill-opacity="0.6" stroke="${r}" stroke-width="1.8"/>
      <line x1="${x - 6}" y1="${y - 2}" x2="${x + 6}" y2="${y + 2}" stroke="${r}" stroke-width="2.2"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-24 -24 48 48">
    <path d="M-11 -11 L11 11 M11 -11 L-11 11" stroke="#121110" stroke-width="6"/>
    <path d="M-11 -11 L11 11 M11 -11 L-11 11" stroke="${c}" stroke-width="3"/>${rotors}
    <rect x="-5" y="-6" width="10" height="12" fill="${c}" stroke="#121110" stroke-width="1.5"/>
    <path d="M0 -15 L-4.5 -8 L4.5 -8 Z" fill="${c}" stroke="#121110" stroke-width="1"/></svg>`;
  return { id: `quad-${kind}`, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 96, height: 96, anchorX: 48, anchorY: 48 };
}
const ICONS = { hostile: quadIcon('hostile'), lost: quadIcon('lost'), friendly: quadIcon('friendly') };

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
const line = (pts: [number, number][], props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts } });
const poly = (rings: [number, number][][], props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: rings } });
const km = (m: number) => `${(m / 1000).toFixed(1)} KM`;
const OPENING_ZOOM_IN = 0.3; // pitched views fit the whole area with lots of sky; step in toward the action
// Frame the area that matters: everywhere a drone flies in this scenario (falls back to the sensors), plus a margin.
function activityBounds(s: Scenario): [[number, number], [number, number]] {
  const last = s.frames[s.frames.length - 1];
  const pts: Point[] = last?.tracks.flatMap((tr) => tr.points) ?? [];
  const src = pts.length ? pts : s.sensors;
  if (!src.length) return BOX_BOUNDS;
  const pad = 900;
  const xs = src.map((q) => q.x), ys = src.map((q) => q.y);
  const lo = clampToBox({ x: Math.min(...xs) - pad, y: Math.min(...ys) - pad });
  const hi = clampToBox({ x: Math.max(...xs) + pad, y: Math.max(...ys) + pad });
  return [toLngLat(lo.x, lo.y), toLngLat(hi.x, hi.y)];
}
// Keep the box clear of the floating side card and the camera stack.
const framePadding = (map: MLMap) => {
  const w = map.getContainer().clientWidth;
  return w < 700 ? { top: 60, bottom: 160, left: 20, right: 70 } : { top: 70, bottom: 50, left: Math.min(330, Math.round(w * 0.36)), right: 100 };
};

type Drone = { id: string; kind: Kind; x: number; y: number; hdg: number; spd: number; alt: number; track: Track };

type Props = {
  scenario: Scenario;
  t: number;
  playing: boolean;
  selectedTrack: string | null;
  onSelectTrack: (id: string | null) => void;
  reconRoute: ReconRoute | null;
};

export default function OpsMap(p: Props) {
  const { scenario: s, t } = p;
  const box = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [ready, setReady] = useState(false);
  const [elev, setElev] = useState<ElevationFn>(() => flatElevation);
  const [bearing, setBearing] = useState(-20);
  const [pitch, setPitch] = useState(58);
  const [mode, setMode] = useState<OpsMode>('enemy');
  const [start, setStart] = useState<Point>(HOME_BASE);
  const [goal, setGoal] = useState<Point | null>(null);
  const [pickStart, setPickStart] = useState(false);
  const [activeRoute, setActiveRoute] = useState(0);
  const [k, setK] = useState(1); // glide between the previous and current simulated second
  const [cardOpen, setCardOpen] = useState(() => window.innerWidth >= 700);

  const frame = frameAt(s, t);
  const prev = t > 0 ? frameAt(s, t - 1) : undefined;

  // Latest values for map event handlers registered once.
  const live = useRef({ mode, pickStart, elev, onSelect: p.onSelectTrack, scenario: s });
  live.current = { mode, pickStart, elev, onSelect: p.onSelectTrack, scenario: s };
  const lastHeat = useRef('');

  // ---- map + overlay, created once ----
  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({
      container: box.current,
      style: {
        version: 8,
        sources: {
          imagery: { type: 'raster', tiles: [IMAGERY_URL], tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
          dem: { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, encoding: 'terrarium', maxzoom: DEM_ZOOM, attribution: 'Terrain © Mapzen / AWS Terrain Tiles' },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0e0d0c' } },
          { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-saturation': -0.3, 'raster-brightness-max': 0.82, 'raster-contrast': 0.08 } },
        ],
        terrain: { source: 'dem', exaggeration: EXAGGERATION },
      },
      bounds: BOX_BOUNDS,
      fitBoundsOptions: { padding: 40 },
      maxPitch: 85,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 140 }), 'bottom-right');

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      pickingRadius: 6,
      onClick: (info: PickingInfo) => {
        const o = info.object as { id?: string; kind?: Kind } | undefined;
        if (info.layer?.id === 'drones' && o?.id && o.kind !== 'friendly') live.current.onSelect(o.id);
      },
      getTooltip: ({ object, layer }: PickingInfo) => {
        if (!object || !layer) return null;
        if (layer.id === 'towers') {
          const x = object as Sensor;
          return { html: `<b>${x.id}</b> · ${x.side} ${x.type} · range ${x.range_m} m${x.active ? '' : ' · disabled'}`, className: 'ops-tip' };
        }
        if (layer.id === 'drones') return { html: `<b>${(object as Drone).id}</b> · click for track card`, className: 'ops-tip' };
        return null;
      },
    });
    overlayRef.current = overlay;
    map.addControl(overlay as unknown as maplibregl.IControl);
    if (import.meta.env.DEV) (window as unknown as { __ops: unknown }).__ops = { map, overlay }; // console debugging only

    map.on('load', () => {
      const ring = BOX_CORNERS.concat([BOX_CORNERS[0]]);
      map.addSource('mask', { type: 'geojson', data: fc([poly([[[-179, -84], [179, -84], [179, 84], [-179, 84], [-179, -84]], [...ring].reverse()])]) });
      map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#0e0d0c', 'fill-opacity': 0.35 } });
      const gridLines: GeoJSON.Feature[] = [];
      for (let v = 0; v <= MAP_SIZE; v += 1000) {
        gridLines.push(line([toLngLat(v, 0), toLngLat(v, MAP_SIZE)]), line([toLngLat(0, v), toLngLat(MAP_SIZE, v)]));
      }
      map.addSource('grid', { type: 'geojson', data: fc(gridLines) });
      map.addLayer({ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#eeeae2', 'line-opacity': 0.12, 'line-width': 1 } });
      map.addSource('box', { type: 'geojson', data: fc([line(ring)]) });
      map.addLayer({ id: 'box', type: 'line', source: 'box', paint: { 'line-color': '#eeeae2', 'line-opacity': 0.55, 'line-width': 1.5 } });

      map.addSource('heat', { type: 'image', url: EMPTY_IMAGE, coordinates: BOX_CORNERS });
      map.addLayer({ id: 'heat', type: 'raster', source: 'heat', paint: { 'raster-opacity': 0.92, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });

      for (const id of ['rings', 'origins', 'teams', 'sites', 'routes', 'recon']) map.addSource(id, { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'rings-fill', type: 'fill', source: 'rings', paint: { 'fill-color': ['match', ['get', 'side'], 'allied', '#5aa9ff', '#f0332b'], 'fill-opacity': ['case', ['get', 'active'], 0.05, 0.015] } });
      map.addLayer({ id: 'rings-line', type: 'line', source: 'rings', filter: ['==', ['get', 'active'], true], paint: { 'line-color': ['match', ['get', 'side'], 'allied', '#5aa9ff', '#f0332b'], 'line-width': 1.6, 'line-opacity': 0.75 } });
      map.addLayer({ id: 'rings-off', type: 'line', source: 'rings', filter: ['==', ['get', 'active'], false], paint: { 'line-color': '#8f8a84', 'line-width': 1.2, 'line-dasharray': [3, 3] } });
      map.addLayer({ id: 'origins', type: 'line', source: 'origins', paint: { 'line-color': '#ffb02e', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'teams', type: 'line', source: 'teams', paint: { 'line-color': '#ffb02e', 'line-width': 3.5 } });
      map.addLayer({ id: 'sites', type: 'line', source: 'sites', paint: { 'line-color': '#3fd68a', 'line-width': 2.5 } });
      map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#121110', 'line-width': ['case', ['get', 'active'], 10, 7], 'line-opacity': 0.75 } });
      map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['case', ['get', 'active'], '#eeeae2', '#5aa9ff'], 'line-width': ['case', ['get', 'active'], 5, 3] } });
      map.addLayer({ id: 'recon', type: 'line', source: 'recon', paint: { 'line-color': '#eeeae2', 'line-width': 2, 'line-dasharray': [1, 2] } });

      map.fitBounds(activityBounds(live.current.scenario), { padding: framePadding(map), duration: 0 });
      map.jumpTo({ pitch: 55, bearing: -15, zoom: map.getZoom() + OPENING_ZOOM_IN });
      setReady(true);
    });

    map.on('rotate', () => setBearing(map.getBearing()));
    map.on('pitch', () => setPitch(map.getPitch()));
    map.on('mousemove', (e: MapMouseEvent) => {
      if (!cursor.current) return;
      const { lng, lat } = e.lngLat;
      const sp = fromLngLat(lng, lat);
      const h = live.current.elev(sp.x, sp.y) / EXAGGERATION;
      const inside = sp.x >= 0 && sp.y >= 0 && sp.x <= MAP_SIZE && sp.y <= MAP_SIZE;
      cursor.current.textContent = `${lat.toFixed(4)}°N ${Math.abs(lng).toFixed(4)}°W  ELEV ${Math.round(h)} M${inside ? `  SIM ${String(Math.round(sp.x)).padStart(5, '0')} ${String(Math.round(sp.y)).padStart(5, '0')}` : ''}`;
    });
    map.on('mouseout', () => { if (cursor.current) cursor.current.textContent = 'CURSOR OFF MAP'; });
    map.on('click', (e: MapMouseEvent) => {
      const hit = overlayRef.current?.pickObject({ x: e.point.x, y: e.point.y, radius: 6 });
      if (hit?.object) return;
      const L = live.current;
      if (L.mode === 'route') {
        const pt = clampToBox(fromLngLat(e.lngLat.lng, e.lngLat.lat));
        if (L.pickStart) { setStart(pt); setPickStart(false); } else { setGoal(pt); }
        setActiveRoute(0);
      } else if (L.mode === 'enemy') {
        L.onSelect(null);
      }
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; overlayRef.current = null; };
  }, []);

  useEffect(() => {
    let alive = true;
    loadElevation().then((fn) => { if (alive) setElev(() => fn); }).catch((e) => console.warn('terrain sampler unavailable, drawing at sea level', e));
    return () => { alive = false; };
  }, []);

  // Glide drones from last second's position to this second's while playing (4x: one second per STEP_MS).
  useEffect(() => {
    if (!p.playing || reduceMotion()) { setK(1); return; }
    setK(0);
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const v = Math.min(1, (now - t0) / STEP_MS);
      setK(v);
      if (v < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [t, p.playing]);

  // Clock for the radar sweeps (about 30 fps; paused for reduced motion).
  const [sweepMs, setSweepMs] = useState(0);
  useEffect(() => {
    if (reduceMotion()) return;
    let raf = 0, last = 0;
    const tick = (now: number) => {
      if (now - last > 33) { last = now; setSweepMs(now); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const atTerrain = useCallback((x: number, y: number, up = 0): [number, number, number] => [...toLngLat(x, y), elev(x, y) + up], [elev]);
  const coverage = useMemo(
    () => coverageLayers(s.sensors, atTerrain, { focus: mode === 'enemy' ? 'allied' : 'enemy', timeMs: sweepMs }),
    [s.sensors, atTerrain, mode, sweepMs],
  );

  // ---- derived data ----
  // Route threat = enemy sensor exposure + 0.6 × where the enemy is expected to launch next.
  const threat: Grid | null = useMemo(() => {
    if (!frame) return null;
    const exposure = frame.exposure_grid, forecast = frame.forecast_heatmap;
    if (!hasValues(exposure) && !hasValues(forecast)) return null;
    const zeros: Grid = { cell_m: 100, width: 100, height: 100, values: Array.from({ length: 100 }, () => new Array<number>(100).fill(0)) };
    return blend(hasValues(exposure) ? exposure : zeros, forecast, 0.6);
  }, [frame]);
  const routes = useMemo(() => (goal && threat ? planRoutes(threat, start, goal) : []), [threat, start, goal]);
  const dets = useMemo(() => s.frames.filter((f) => f.t <= t).flatMap((f) => f.detections), [s, t]);
  const firstSeen = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of s.frames) for (const d of f.detections) if (d.truth_drone_id && !m.has(d.truth_drone_id) && !d.clutter) m.set(d.truth_drone_id, d.t);
    return m;
  }, [s]);
  const enemyHeat = useMemo(() => (frame?.origins.length ? confidenceGrid(frame.origins) : null), [frame]);

  const drones: Drone[] = useMemo(() => {
    if (!frame) return [];
    const before = new Map(prev?.tracks.map((x) => [x.id, x.current]) ?? []);
    return frame.tracks.map((tr) => {
      const lost = tr.status === 'lost';
      const pv = before.get(tr.id);
      const g = !lost && pv ? k : 1;
      const x = pv ? pv.x + (tr.current.x - pv.x) * g : tr.current.x;
      const y = pv ? pv.y + (tr.current.y - pv.y) * g : tr.current.y;
      const t0 = tr.points[0]?.t ?? t;
      const tNow = lost ? (tr.points[tr.points.length - 1]?.t ?? t) : t - 1 + k;
      return { id: tr.id, kind: lost ? 'lost' : 'hostile', x, y, hdg: headingDeg(tr.current.vx, tr.current.vy), spd: speedMs(tr.current.vx, tr.current.vy), alt: agl(tNow, t0), track: tr };
    });
  }, [frame, prev, k, t]);

  // ---- MapLibre: heat + draped vectors per tab ----
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !frame) return;
    const heat = map.getSource('heat') as ImageSource;
    let url = EMPTY_IMAGE;
    if (mode === 'enemy' && enemyHeat) url = heatImage(enemyHeat, 1, 320, 1.5);
    if (mode === 'launch' && hasValues(s.launch_site_grid)) url = heatImage(s.launch_site_grid);
    if (mode === 'route' && threat) url = heatImage(threat);
    map.setPaintProperty('heat', 'raster-opacity', mode === 'enemy' ? 0.92 : 0.72); // wide-area tabs stay see-through
    if (url !== lastHeat.current) { // an update while one is decoding aborts it, so skip no-op updates
      lastHeat.current = url;
      heat.updateImage({ url, coordinates: BOX_CORNERS });
    }

    const set = (id: string, features: GeoJSON.Feature[]) => (map.getSource(id) as GeoJSONSource).setData(fc(features));
    set('rings', []); // sensor coverage is drawn in 3D by coverage.ts
    set('origins', mode === 'enemy' ? frame.origins.map((o) => poly([circleRing(o.peak.x, o.peak.y, o.radius_m, 48)])) : []);
    set('teams', mode === 'enemy' ? frame.launch_teams.filter((lt) => lt.origin_history.length > 1).map((lt) => line(lt.origin_history.map((h) => toLngLat(h.x, h.y)))) : []);
    set('sites', mode === 'launch' ? s.launch_site_options.map((o) => poly([circleRing(o.x, o.y, 300, 48)])) : []);
    const routeLines = routes.map((r, i) => line(r.points.map((q) => toLngLat(q.x, q.y)), { active: i === activeRoute }));
    set('routes', mode === 'route' ? [...routeLines.filter((f) => !f.properties?.active), ...routeLines.filter((f) => f.properties?.active)] : []);
    const rr = p.reconRoute;
    set('recon', rr && mode !== 'launch' ? [line(rr.waypoints.map((q) => toLngLat(q.x, q.y))), ...(frame.recon ? [poly([circleRing(frame.recon.x, frame.recon.y, 1000, 48)])] : [])] : []);
  }, [ready, frame, mode, s, enemyHeat, threat, routes, activeRoute, p.reconRoute]);

  // ---- deck.gl: 3D objects ----
  const layers = useMemo(() => {
    if (!frame) return [];
    const at = (x: number, y: number, up = 0): [number, number, number] => [...toLngLat(x, y), elev(x, y) + up];
    const sel = p.selectedTrack;
    const text = (id: string, data: unknown[], extra: Record<string, unknown>) => new TextLayer({
      id, data, fontFamily: FONT, fontWeight: 700, characterSet: 'auto', sizeUnits: 'pixels', getSize: 13,
      background: true, getBackgroundColor: [18, 17, 16, 220], backgroundPadding: [6, 3], billboard: true,
      getColor: rgba(RGB.friendly), getTextAnchor: 'middle', getAlignmentBaseline: 'center', ...extra,
    });
    const out: Layer[] = [];

    out.push(new ColumnLayer<Sensor>({
      id: 'towers', data: s.sensors, diskResolution: 4, angle: 45, radius: 55, extruded: true, pickable: true,
      getPosition: (x) => at(x.x, x.y), getElevation: 300,
      getFillColor: (x) => rgba(x.side === 'allied' ? RGB.allied : RGB.enemy, x.active ? 240 : 80),
      updateTriggers: { getPosition: elev },
    }));
    out.push(text('tower-labels', s.sensors, {
      getPosition: (x: Sensor) => at(x.x, x.y, 360), getSize: 12, getText: (x: Sensor) => `${x.id} ${SENSOR_CODE[x.type]}${x.active ? '' : ' OFF'}`,
      getColor: (x: Sensor) => rgba(x.side === 'allied' ? RGB.allied : RGB.enemy), updateTriggers: { getPosition: elev },
    }));

    if (mode === 'enemy') {
      out.push(new ScatterplotLayer<Detection>({
        id: 'detections', data: dets, radiusUnits: 'meters', getRadius: (d) => (d.clutter ? 20 : 26),
        getPosition: (d) => at(d.x, d.y, d.clutter || !d.truth_drone_id ? 12 : agl(d.t, firstSeen.get(d.truth_drone_id) ?? d.t)),
        getFillColor: (d) => (d.clutter ? rgba(RGB.clutter, 70) : rgba(RGB.det, sel ? 60 : 150)),
        updateTriggers: { getPosition: elev, getFillColor: sel },
      }));
      const dim = (id: string) => (sel && sel !== id ? 70 : 230);
      out.push(new PathLayer<Drone>({
        id: 'flight-paths', data: drones, widthUnits: 'pixels', billboard: true, capRounded: true, jointRounded: true,
        getPath: (d) => [...d.track.points.map((q) => at(q.x, q.y, agl(q.t, d.track.points[0].t))), at(d.x, d.y, d.alt)],
        getWidth: (d) => (d.id === sel ? 5 : 3), getColor: (d) => rgba(d.kind === 'lost' ? RGB.lost : RGB.hostile, dim(d.id)),
        updateTriggers: { getPath: [elev, k], getColor: sel, getWidth: sel },
      }));
      out.push(new LineLayer<Drone>({
        id: 'drop-lines', data: drones, widthUnits: 'pixels', getWidth: 1.5,
        getSourcePosition: (d) => at(d.x, d.y, d.alt), getTargetPosition: (d) => at(d.x, d.y),
        getColor: (d) => rgba(RGB.friendly, sel && sel !== d.id ? 40 : 150), updateTriggers: { getSourcePosition: [elev, k], getTargetPosition: [elev, k], getColor: sel },
      }));
      out.push(new ScatterplotLayer<Drone>({
        id: 'ground-marks', data: drones, radiusUnits: 'meters', getRadius: 40, stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1.5,
        getPosition: (d) => at(d.x, d.y, 6), getFillColor: [0, 0, 0, 110], getLineColor: (d) => rgba(d.kind === 'lost' ? RGB.lost : RGB.hostile, 160),
        updateTriggers: { getPosition: [elev, k] },
      }));
      out.push(new LineLayer({
        id: 'origin-stalks', data: frame.origins, widthUnits: 'pixels', getWidth: 2.5, getColor: rgba(RGB.origin),
        getSourcePosition: (o: { peak: Point }) => at(o.peak.x, o.peak.y), getTargetPosition: (o: { peak: Point }) => at(o.peak.x, o.peak.y, 260),
        updateTriggers: { getSourcePosition: elev, getTargetPosition: elev },
      }));
      // One label per launch-team site (several tracks share a site); per-track origins only for the selection.
      const conf = new Map(frame.origins.map((o) => [o.track_id, o.confidence]));
      const sites = frame.launch_teams.flatMap((lt) => lt.origin_history.map((h, i) => ({
        x: h.x, y: h.y, label: `${lt.id} SITE ${i + 1}${lt.confirmed && i === lt.origin_history.length - 1 ? ' · CONFIRMED' : ` · ${pct(Math.max(0, ...lt.track_ids.map((id) => conf.get(id) ?? 0)))}`}`,
      })));
      out.push(text('site-labels-enemy', sites, {
        getPosition: (q: Point) => at(q.x, q.y, 300), getText: (q: { label: string }) => q.label, getColor: rgba(RGB.origin), updateTriggers: { getPosition: elev },
      }));
      const selO = frame.origins.filter((o) => o.track_id === sel);
      out.push(text('origin-labels', selO, {
        getPosition: (o: { peak: Point }) => at(o.peak.x, o.peak.y, 160), getColor: rgba(RGB.friendly), getPixelOffset: [0, 22],
        getText: (o: { track_id: string; confidence: number; radius_m: number }) => `${o.track_id} ORIGIN ${pct(o.confidence)} ±${Math.round(o.radius_m)}M`, updateTriggers: { getPosition: elev },
      }));
      out.push(new IconLayer<Drone>({
        id: 'drones', data: drones, pickable: true, billboard: true, sizeUnits: 'pixels',
        getIcon: (d) => ICONS[d.kind], getSize: (d) => (d.id === sel ? 60 : 46), getPosition: (d) => at(d.x, d.y, d.alt),
        getAngle: (d) => (d.kind === 'lost' ? 0 : bearing - d.hdg), getColor: (d) => [255, 255, 255, sel && sel !== d.id ? 90 : 255],
        updateTriggers: { getPosition: [elev, k], getAngle: bearing, getSize: sel, getColor: sel },
      }));
      out.push(text('drone-labels', drones, {
        getPosition: (d: Drone) => at(d.x, d.y, d.alt), getPixelOffset: [34, 0], getTextAnchor: 'start',
        getText: (d: Drone) => (d.kind === 'lost' ? `${d.id} LOST` : d.id === sel ? `${d.id} ${Math.round(d.spd)}M/S ${Math.round(d.alt)}M` : d.id),
        getColor: (d: Drone) => rgba(d.kind === 'lost' ? RGB.lost : RGB.hostile, sel && sel !== d.id ? 90 : 255),
        updateTriggers: { getPosition: [elev, k], getColor: sel },
      }));
    }

    if (mode === 'launch') {
      const opts = s.launch_site_options;
      out.push(new ColumnLayer({
        id: 'site-pillars', data: opts, diskResolution: 12, radius: 70, extruded: true, getElevation: 240,
        getPosition: (o: Point) => at(o.x, o.y), getFillColor: rgba(RGB.safe, 230), updateTriggers: { getPosition: elev },
      }));
      out.push(text('site-labels', opts.map((o, i) => ({ ...o, n: i + 1 })), {
        getPosition: (o: Point) => at(o.x, o.y, 300), getColor: rgba(RGB.safe),
        getText: (o: { n: number; concealment: number }) => `SITE ${o.n} · ${pct(o.concealment)} CONCEALED`, updateTriggers: { getPosition: elev },
      }));
    }

    if (mode !== 'enemy') {
      const pins = mode === 'route'
        ? [{ ...start, label: start === HOME_BASE ? 'START · HOME BASE' : 'START', c: RGB.friendly }, ...(goal ? [{ ...goal, label: 'DESTINATION', c: RGB.origin }] : [])]
        : [{ ...HOME_BASE, label: 'HOME BASE', c: RGB.friendly }];
      out.push(new LineLayer({
        id: 'pins', data: pins, widthUnits: 'pixels', getWidth: 3, getColor: (q: { c: readonly number[] }) => rgba(q.c),
        getSourcePosition: (q: Point) => at(q.x, q.y), getTargetPosition: (q: Point) => at(q.x, q.y, 320), updateTriggers: { getSourcePosition: elev, getTargetPosition: elev },
      }));
      out.push(text('pin-labels', pins, {
        getPosition: (q: Point) => at(q.x, q.y, 360), getText: (q: { label: string }) => q.label,
        getColor: (q: { c: readonly number[] }) => rgba(q.c), updateTriggers: { getPosition: elev },
      }));
    }

    if (mode === 'route' && routes.length) {
      out.push(text('route-labels', routes.map((r, i) => ({ r, i, mid: r.points[Math.floor(r.points.length / 2)] })), {
        getPosition: (o: { mid: Point }) => at(o.mid.x, o.mid.y, 140),
        getText: (o: { r: { id: string; length_m: number; risk: number } }) => `ROUTE ${o.r.id} · ${km(o.r.length_m)} · RISK ${pct(o.r.risk)}`,
        getColor: (o: { i: number }) => (o.i === activeRoute ? rgba(RGB.friendly) : rgba(RGB.allied)), updateTriggers: { getPosition: elev, getColor: activeRoute },
      }));
    }

    const r = frame.recon;
    if (r && mode !== 'launch') {
      const before = prev?.recon?.route_id === r.route_id ? prev.recon : null;
      const g = before && p.playing ? k : 1;
      const rx = before ? before.x + (r.x - before.x) * g : r.x, ry = before ? before.y + (r.y - before.y) * g : r.y;
      const hdg = before ? headingDeg(r.x - before.x, r.y - before.y) : 0;
      const d = [{ id: r.route_id, kind: 'friendly' as Kind, x: rx, y: ry, hdg, alt: SURVEY_AGL, status: r.status, risk: r.risk_now }];
      if (p.reconRoute) {
        out.push(new PathLayer({
          id: 'survey-path', data: [p.reconRoute], widthUnits: 'pixels', getWidth: 2, billboard: true,
          getPath: (rr: ReconRoute) => rr.waypoints.map((q) => at(q.x, q.y, SURVEY_AGL)), getColor: rgba(RGB.friendly, 170), updateTriggers: { getPath: elev },
        }));
      }
      out.push(new LineLayer({
        id: 'survey-drop', data: d, widthUnits: 'pixels', getWidth: 1.5, getColor: rgba(RGB.allied, 170),
        getSourcePosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), getTargetPosition: (q: Point) => at(q.x, q.y), updateTriggers: { getSourcePosition: [elev, k], getTargetPosition: [elev, k] },
      }));
      out.push(new IconLayer({
        id: 'survey-drone', data: d, billboard: true, sizeUnits: 'pixels', getIcon: () => ICONS.friendly, getSize: 52,
        getPosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), getAngle: (q: { hdg: number }) => bearing - q.hdg, updateTriggers: { getPosition: [elev, k], getAngle: bearing },
      }));
      out.push(text('survey-label', d, {
        getPosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), getPixelOffset: [36, 0], getTextAnchor: 'start', getColor: rgba(RGB.allied),
        getText: (q: { id: string; status: string; risk: number }) => `${q.id} SURVEY · ${q.status.toUpperCase()} · RISK ${pct(q.risk)}`, updateTriggers: { getPosition: [elev, k] },
      }));
    }
    return out;
  }, [frame, prev, s, elev, mode, drones, dets, firstSeen, p.selectedTrack, p.reconRoute, p.playing, bearing, k, start, goal, routes, activeRoute]);

  useEffect(() => { overlayRef.current?.setProps({ layers: [...coverage, ...layers] }); }, [coverage, layers]);

  // ---- camera ----
  const cam = (o: { pitch?: number; bearing?: number }) => mapRef.current?.easeTo({ ...o, duration: 600 });
  const recenter = () => {
    const map = mapRef.current;
    if (!map) return;
    const { pitch: pt, bearing: br } = { pitch: map.getPitch(), bearing: map.getBearing() };
    const cam0 = map.cameraForBounds(activityBounds(s), { padding: framePadding(map) });
    if (cam0) map.easeTo({ ...cam0, zoom: (cam0.zoom ?? map.getZoom()) + (pt > 20 ? OPENING_ZOOM_IN : 0), pitch: pt, bearing: br, duration: 600 });
  };
  const flyTo = (q: Point) => mapRef.current?.flyTo({ center: toLngLat(q.x, q.y), zoom: 14, pitch: Math.max(50, pitch), duration: 1200 });

  const m = MODES.find((x) => x.id === mode)!;
  const selTrack = frame?.tracks.find((x) => x.id === p.selectedTrack) ?? null;
  const selDrone = drones.find((d) => d.id === p.selectedTrack) ?? null;
  const selOrigin = frame?.origins.find((o) => o.track_id === p.selectedTrack) ?? null;
  const selTeam = frame?.launch_teams.find((lt) => lt.track_ids.includes(p.selectedTrack ?? '')) ?? null;

  return (
    <div className="ops">
      <div ref={box} className="ops-map" />

      <div className="ops-modes" role="tablist" aria-label="Map layer">
        {MODES.map((x) => (
          <button key={x.id} role="tab" aria-selected={mode === x.id} className={mode === x.id ? 'on' : ''}
            onClick={() => { setMode(x.id); setPickStart(false); }}>{x.label}</button>
        ))}
      </div>
      <div className="badge sim-badge">SIM // ALL DATA SIMULATED</div>

      <section className={`ops-card${cardOpen ? '' : ' is-collapsed'}`} aria-label={`${m.label} panel`}>
        <button className="ops-collapse" onClick={() => setCardOpen((v) => !v)} aria-expanded={cardOpen}>
          {cardOpen ? 'Hide panel' : `${m.label} panel`}
        </button>
        {cardOpen && (<>
        {mode === 'enemy' && (selTrack && selDrone ? (
          <>
            <div className="ops-card-head">
              <span className="micro">Track · hostile air</span>
              <button className="ops-x" onClick={() => p.onSelectTrack(null)} aria-label="Close track card">✕</button>
            </div>
            <h2 className="ops-title hostile">{selTrack.id}<small>{selTrack.status === 'lost' ? 'LOST' : 'ACTIVE'}</small></h2>
            <dl className="ops-data">
              <div><dt>Speed</dt><dd>{Math.round(selDrone.spd)} m/s</dd></div>
              <div><dt>Heading</dt><dd>{pad3(selDrone.hdg)}°</dd></div>
              <div><dt>Alt (sim)</dt><dd>{Math.round(selDrone.alt)} m AGL</dd></div>
              <div><dt>First fix</dt><dd>T+{pad3(selTrack.points[0]?.t ?? 0)}</dd></div>
              <div><dt>Sensors</dt><dd>{selTrack.sensor_ids.join(' ') || '–'}</dd></div>
              <div><dt>Team</dt><dd>{selTeam?.id ?? '–'}</dd></div>
            </dl>
            {selOrigin && (
              <p className="ops-note">Launch origin near ({Math.round(selOrigin.peak.x / 10) * 10}, {Math.round(selOrigin.peak.y / 10) * 10}) m · {pct(selOrigin.confidence)} confidence · ±{Math.round(selOrigin.radius_m)} m</p>
            )}
            <button className="primary" onClick={() => flyTo(selDrone)}>Focus camera</button>
          </>
        ) : (
          <>
            <span className="micro">Hostile tracks · T+{pad3(t)}</span>
            {drones.length === 0 && <p className="ops-note">No tracks yet. Press play.</p>}
            <ul className="ops-list">
              {drones.map((d) => (
                <li key={d.id}><button onClick={() => { p.onSelectTrack(d.id); }}>
                  <b className={d.kind === 'lost' ? 'lost' : 'hostile'}>{d.id}</b>
                  <span>{d.kind === 'lost' ? 'LOST' : `${Math.round(d.spd)} M/S · ${pad3(d.hdg)}°`}</span>
                </button></li>
              ))}
            </ul>
            <p className="ops-note">Click a drone for its track card. Right-drag or use the controls to tilt and rotate.</p>
          </>
        ))}

        {mode === 'launch' && (
          <>
            <span className="micro">Our safest launch sites</span>
            {!s.launch_site_options.length && <p className="ops-note">No launch-site analysis for this scenario.</p>}
            <ul className="ops-list">
              {s.launch_site_options.map((o, i) => (
                <li key={i}><button onClick={() => flyTo(o)}>
                  <b className="safe">SITE {i + 1}</b>
                  <span>{pct(o.concealment)} concealed{o.distance_to_coverage_m != null ? ` · ${km(o.distance_to_coverage_m)} from coverage` : ''}</span>
                </button></li>
              ))}
            </ul>
            <p className="ops-note">Hardest places for enemy sensors to trace a launch back to. Click a site to fly there.</p>
          </>
        )}

        {mode === 'route' && (
          <>
            <span className="micro">Safest route</span>
            <p className="ops-note">{pickStart ? 'Click the map to set the start.' : goal ? 'Click the map to move the destination.' : 'Click the map to mark where you want to go.'}</p>
            <div className="ops-row">
              <button className={`ghost ${pickStart ? 'on' : ''}`} onClick={() => setPickStart((v) => !v)}>{pickStart ? 'Cancel' : 'Set start'}</button>
              <button className="ghost" onClick={() => { setGoal(null); setStart(HOME_BASE); setPickStart(false); }}>Clear</button>
            </div>
            <ul className="ops-list">
              {routes.map((r, i) => (
                <li key={r.id}><button className={i === activeRoute ? 'on' : ''} onClick={() => setActiveRoute(i)}>
                  <b>ROUTE {r.id}</b>
                  <span>{km(r.length_m)} · risk {pct(r.risk)} · peak {pct(r.max_threat)}</span>
                </button></li>
              ))}
            </ul>
            {goal && !routes.length && <p className="ops-note">No threat data for this frame yet.</p>}
            <p className="ops-note">Routes avoid enemy sensor coverage and expected launch areas. A recommendation; the operator decides.</p>
          </>
        )}
        </>)}
      </section>

      <div className="ops-legend" aria-label="Heat legend">
        <span className="micro">{m.red}</span>
        <div className="ops-ramp">
          <span>{m.low}</span>
          {LEGEND_SWATCHES.map((c, i) => <i key={i} style={{ background: c }} />)}
          <span>{m.high}</span>
        </div>
      </div>

      <div className="ops-camera" aria-label="Camera">
        <button className={pitch < 5 ? 'on' : ''} onClick={() => cam({ pitch: 0, bearing: 0 })}>2D</button>
        <button className={pitch >= 5 ? 'on' : ''} onClick={() => cam({ pitch: 62, bearing: bearing || -20 })}>3D</button>
        <button onClick={() => cam({ bearing: bearing - 30 })} aria-label="Rotate left">⟲</button>
        <button onClick={() => cam({ bearing: bearing + 30 })} aria-label="Rotate right">⟳</button>
        <button onClick={() => cam({ pitch: Math.min(85, pitch + 10) })} aria-label="Tilt up">▲</button>
        <button onClick={() => cam({ pitch: Math.max(0, pitch - 10) })} aria-label="Tilt down">▼</button>
        <button onClick={recenter} aria-label="Recenter">⌖</button>
        <output className="ops-cam-readout">P{pad3(pitch)} B{pad3((bearing + 360) % 360)}</output>
      </div>
      <div ref={cursor} className="hud-readout ops-readout" aria-hidden="true">CURSOR OFF MAP</div>
    </div>
  );
}
