// 3D operations map: satellite imagery on real terrain (MapLibre), one draped heat layer per tab, and deck.gl for
// the things that live in 3D (sensor masts, drone flight paths, survey drone). Inspired by Lattice / Gotham layouts,
// drawn in this project's tactical-telemetry style. All data is simulated; terrain placement is illustrative.
import type { Layer, PickingInfo } from '@deck.gl/core';
import { ColumnLayer, IconLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import maplibregl, { type GeoJSONSource, type Map as MLMap, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './ops.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { headingDeg, pad3, speedMs, STEP_MS } from '../drones';
import { MAP_SIZE, pct } from '../geo';
import { frameAt } from '../MapView';
import { conePoints, isTriangulated, sitesOf, type Site } from '../backtrack';
import type { Detection, Grid, OriginEstimate, Point, ReconRoute, Scenario, Sensor, Track } from '../types';
import {
  BOX_BOUNDS, BOX_CORNERS, circleRing, clampToBox, DEM_URL, DEM_ZOOM, EXAGGERATION, flatElevation, fromLngLat, HOME_BASE,
  IMAGERY_URL, loadElevation, toLngLat, type ElevationFn,
} from './geo3d';
import { coverageLayers } from './coverage';
import { toMGRS } from './mgrs';
import { detectionField, enemyOriginField, hostileActivityField, routeThreatField, safeLaunchField } from './analytics';
import { heatFrame, legendSwatches, lift, revealFrame, type HeatFrame, type Palette } from './heat';
import { addHeatLayers, setHeat } from './heatTiles';
import { planRoutes } from './route';
import AutonomyPanel from './AutonomyPanel';
import {
  abortMission, areaName, armMission, DEFAULT_MISSION, initMission, isActive, latestFindings, missionLayers, stepMission, surveyQueue,
  uncertaintyGrid, type Box, type MissionContext, type MissionState, type SurveyOption,
} from './autonomy';
import { fuseLaunch, fuseOrigin, mappedShare, surveyNote, type SurveyEvidence } from './fusion';
import { AFFIL, affiliationOf, natoIcon, natoSvg, trackConfidence, type Affiliation } from './symbols';
import { ConfMeter, EvidenceTrend } from './TrackEvidence';
import ProvenanceView from './Provenance';

export type OpsMode = 'enemy' | 'launch' | 'route' | 'survey' | 'provenance';
// One colour family per meaning (heat.ts): red = enemy / threat, green = safe for us, amber = unknown.
const MODES: { id: OpsMode; code: string; label: string; palette: Palette; red: string; low: string; high: string }[] = [
  { id: 'enemy', code: '01', label: 'Enemy origins', palette: 'threat', red: 'Red = likely enemy launch area (model estimate)', low: 'Unlikely', high: 'Likely' },
  { id: 'launch', code: '02', label: 'Safe launch', palette: 'safe', red: 'Green = safest place for us to launch (model estimate)', low: 'Exposed', high: 'Safest' },
  { id: 'route', code: '03', label: 'Route plan', palette: 'threat', red: 'Red = threat: enemy detection, activity, launch areas', low: 'Clear', high: 'Threat' },
  { id: 'survey', code: '04', label: 'Auto survey', palette: 'unknown', red: 'Amber = not yet mapped · red = danger the drone mapped', low: 'Low value', high: 'Unknown' },
  { id: 'provenance', code: '05', label: 'Provenance', palette: 'threat', red: '', low: '', high: '' },
];

type RGBA = [number, number, number, number];
const RGB = {
  hostile: AFFIL.hostile.rgb, lost: [143, 138, 132], friendly: [238, 234, 226], allied: AFFIL.friend.rgb, enemy: AFFIL.hostile.rgb,
  origin: [255, 176, 46], safe: [63, 214, 138], unknown: AFFIL.unknown.rgb,
  det: AFFIL.unknown.rgb, clutter: AFFIL.neutral.rgb, ink: [18, 17, 16], // raw contacts are UNKNOWN, rejected clutter NEUTRAL
} as const;
const rgba = (c: readonly number[], a = 255): RGBA => [c[0], c[1], c[2], a];
const FONT = '"JetBrains Mono", ui-monospace, monospace';
const SENSOR_CODE = { radar: 'RAD', acoustic: 'ACO', rf: 'RF' } as const;

// Display-only altitude: the simulation is 2D, so drones are drawn climbing from their first fix to a cruise height.
const CRUISE_AGL = 140, CLIMB_MS = 9, START_AGL = 20, SURVEY_AGL = 110;
const agl = (t: number, t0: number) => Math.min(CRUISE_AGL, START_AGL + CLIMB_MS * Math.max(0, t - t0));

// NATO affiliation frames (symbols.ts): a track is UNKNOWN until the evidence makes it HOSTILE; lost tracks keep the
// hostile frame, faded. Symbols stay upright; a leader line shows the direction of movement.
type Kind = 'hostile' | 'lost' | 'friendly' | 'unknown';
const ICONS = { hostile: natoIcon('hostile'), lost: natoIcon('hostile'), friendly: natoIcon('friend'), unknown: natoIcon('unknown') };
const kindRGB = (k: Kind) => (k === 'lost' ? RGB.lost : k === 'unknown' ? RGB.unknown : k === 'friendly' ? RGB.allied : RGB.hostile);
const NATO_KEY: Affiliation[] = ['friend', 'hostile', 'neutral', 'unknown'];

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

// x/y/alt at this second, px/py/palt at the previous one (the animation loop glides between them).
type Drone = { id: string; kind: Kind; x: number; y: number; px: number; py: number; hdg: number; spd: number; alt: number; palt: number; track: Track; conf: number; fixes: number };
const DET_WINDOW_S = 30;
const HEAT_STEP_S = 2;
// Autonomous survey clock: 10 ticks per real second; decision phases run at 2x so MAP / PLAN / UPDATE stay readable,
// transit runs at 10x so a whole sortie fits in a couple of minutes of demo.
const MISSION_TICK_S = 0.1, MISSION_RATE_DECIDE = 2, MISSION_RATE_FLY = 10;
const SURVEY_HEAT_S = 5; // mission seconds between survey-heat redraws (0.5 s real time in flight)
const noop = () => undefined;
// A drawn survey area is at least this wide, and always inside the geofence.
const MIN_AREA_M = 800;
function boxFrom(a: Point, b: Point): Box {
  const g = DEFAULT_MISSION.geofence;
  let x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  if (x1 - x0 < MIN_AREA_M) { const c = (x0 + x1) / 2; x0 = c - MIN_AREA_M / 2; x1 = c + MIN_AREA_M / 2; }
  if (y1 - y0 < MIN_AREA_M) { const c = (y0 + y1) / 2; y0 = c - MIN_AREA_M / 2; y1 = c + MIN_AREA_M / 2; }
  return { x0: Math.max(g.x0, x0), y0: Math.max(g.y0, y0), x1: Math.min(g.x1, x1), y1: Math.min(g.y1, y1) };
}

// Resample a polyline every stepM metres so 3D paths follow the terrain instead of cutting through ridges.
function densify(pts: Point[], stepM = 150): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / stepM));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

type Props = {
  scenario: Scenario;
  t: number;
  playing: boolean;
  selectedTrack: string | null;
  onSelectTrack: (id: string | null) => void;
  reconRoute: ReconRoute | null;
  onJump?: (t: number) => void;
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
  const [cardOpen, setCardOpen] = useState(() => window.innerWidth >= 700);
  const [mission, setMission] = useState<MissionState>(() => initMission(DEFAULT_MISSION, null, null));
  const [surveyArea, setSurveyArea] = useState<Box | null>(null); // null = whole AO
  const [areaPick, setAreaPick] = useState<{ on: boolean; corner: Point | null }>({ on: false, corner: null });
  const [pickedId, setPickedId] = useState<string | null>(null);
  const missionCfg = useMemo(() => ({ ...DEFAULT_MISSION, area: surveyArea }), [surveyArea]);
  const missionCfgRef = useRef(missionCfg);
  missionCfgRef.current = missionCfg;
  // Choosing an area (whole AO, a drawn box, or a queue suggestion) re-plans an idle survey; ground already mapped
  // by earlier sorties is carried over. Locked while a sortie is armed or airborne.
  const chooseArea = (box: Box | null, id: string | null = null) => {
    setSurveyArea(box); setPickedId(id); setAreaPick({ on: false, corner: null });
    setMission((m) => (isActive(m.phase) ? m : initMission({ ...DEFAULT_MISSION, area: box }, null, null, m.covered)));
  };
  const surveyClick = (pt: Point) => {
    if (!areaPick.on) return;
    if (!areaPick.corner) { setAreaPick({ on: true, corner: pt }); return; }
    chooseArea(boxFrom(areaPick.corner, pt));
  };
  const camOut = useRef<HTMLOutputElement>(null);
  const card = useRef<HTMLElement>(null);
  const sent = useRef(new Map<string, string>()); // last GeoJSON sent per source
  const tChangedAt = useRef(0); // performance.now() when t last changed, for the glide

  const frame = frameAt(s, t);
  // Heat fields are recomputed at most every HEAT_STEP_S simulated seconds while playing (every second when paused).
  const heatT = p.playing ? t - (t % HEAT_STEP_S) : t;
  const prev = t > 0 ? frameAt(s, t - 1) : undefined;

  // Latest values for map event handlers registered once.
  const live = useRef({ mode, pickStart, elev, onSelect: p.onSelectTrack, scenario: s, surveyClick });
  live.current = { mode, pickStart, elev, onSelect: p.onSelectTrack, scenario: s, surveyClick };

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
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), // full retina terrain is the biggest GPU cost on laptops
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

      addHeatLayers(map); // tiled so it drapes over the terrain

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

    // Camera readout updates imperatively; React only hears about the end of a gesture.
    const readout = () => {
      if (camOut.current) camOut.current.textContent = `P${pad3(map.getPitch())} B${pad3((map.getBearing() + 360) % 360)}`;
    };
    map.on('move', readout);
    map.on('moveend', () => { setBearing(map.getBearing()); setPitch(map.getPitch()); });
    map.on('mousemove', (e: MapMouseEvent) => {
      if (!cursor.current) return;
      const { lng, lat } = e.lngLat;
      const sp = fromLngLat(lng, lat);
      const h = live.current.elev(sp.x, sp.y) / EXAGGERATION;
      const inside = sp.x >= 0 && sp.y >= 0 && sp.x <= MAP_SIZE && sp.y <= MAP_SIZE;
      cursor.current.textContent = `MGRS ${toMGRS(lat, lng)}  ELEV ${Math.round(h)} M${inside ? `  SIM ${String(Math.round(sp.x)).padStart(5, '0')} ${String(Math.round(sp.y)).padStart(5, '0')}` : ''}`;
    });
    map.on('mouseout', () => { if (cursor.current) cursor.current.textContent = 'CURSOR OFF MAP'; });
    map.on('click', (e: MapMouseEvent) => {
      const hit = overlayRef.current?.pickObject({ x: e.point.x, y: e.point.y, radius: 6 });
      if (hit?.object && hit.layer?.id === 'drones') return; // drones handle their own clicks; towers don't block routing
      const L = live.current;
      if (L.mode === 'route') {
        const pt = clampToBox(fromLngLat(e.lngLat.lng, e.lngLat.lat));
        if (L.pickStart) { setStart(pt); setPickStart(false); } else { setGoal(pt); }
        setActiveRoute(0);
      } else if (L.mode === 'enemy') {
        L.onSelect(null);
      } else if (L.mode === 'survey') {
        L.surveyClick(clampToBox(fromLngLat(e.lngLat.lng, e.lngLat.lat)));
      }
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; overlayRef.current = null; setReady(false); sent.current.clear(); };
  }, []);

  useEffect(() => {
    let alive = true;
    loadElevation().then((fn) => { if (alive) setElev(() => fn); }).catch((e) => console.warn('terrain sampler unavailable, drawing at sea level', e));
    return () => { alive = false; };
  }, []);

  useEffect(() => { tChangedAt.current = performance.now(); }, [t]);
  const atTerrain = useCallback((x: number, y: number, up = 0): [number, number, number] => [...toLngLat(x, y), elev(x, y) + up], [elev]);

  // ---- derived data ----
  // Inference fields (analytics.ts): computed from fragmented detections, tracks, sensor geometry and terrain LOS.
  // Detection fields are memoized inside analytics (sensors + terrain are static); the rest refresh every HEAT_STEP_S.
  const terrain = elev === flatElevation ? null : elev;
  const missionOn = isActive(mission.phase);
  const surveyLive = mode === 'survey' || missionOn; // an armed sortie keeps reading live intel from any tab
  const needs = { activity: mode === 'launch' || mode === 'route' || surveyLive, origin: mode === 'enemy' || mode === 'route' || surveyLive };
  const alliedDetect = useMemo(() => detectionField(s.sensors, 'allied', terrain), [s.sensors, terrain]);
  const enemyDetect = useMemo(() => detectionField(s.sensors, 'enemy', terrain), [s.sensors, terrain]);
  const activity = useMemo(() => (needs.activity ? hostileActivityField(s, heatT) : null), [s, heatT, needs.activity]);
  const originField = useMemo(() => (needs.origin ? enemyOriginField(s, heatT, alliedDetect) : null), [s, heatT, alliedDetect, needs.origin]);
  const launchField = useMemo(() => (mode === 'launch' && activity ? safeLaunchField(s, heatT, enemyDetect, activity, terrain) : null), [mode, s, heatT, enemyDetect, activity, terrain]);
  // What the survey has mapped and found feeds back into tabs 01-03 (fusion.ts). Keyed on the mission's value-map
  // refresh so the other pictures update a few times a second during a sortie, not on every tick.
  const evidence: SurveyEvidence = useMemo(() => ({ covered: mission.covered, findings: mission.findings, key: mission.uncertainty }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- covered is read when the value map refreshes
    [mission.uncertainty, mission.findings]);
  const fusedOrigin = useMemo(() => fuseOrigin(originField, evidence), [originField, evidence]);
  const fusedLaunch = useMemo(() => fuseLaunch(launchField, evidence), [launchField, evidence]);
  const fusionNote = useMemo(() => surveyNote(evidence, mappedShare(evidence.covered)), [evidence]);
  const surveySites = useMemo(() => latestFindings(mission.findings).filter((f) => f.kind === 'launch_site'), [mission.findings]);
  const wantThreat = mode === 'route' || surveyLive;
  const threat: Grid | null = useMemo(() => (wantThreat && activity && fusedOrigin ? routeThreatField(enemyDetect, activity, fusedOrigin) : null), [wantThreat, enemyDetect, activity, fusedOrigin]);

  // ---- autonomous survey (tab 04) ----
  // Before arming, preview the value map from the live intel; once armed the mission owns its own state and clock.
  const idlePreview = useMemo(() => (mode === 'survey' && mission.phase === 'idle' ? initMission(missionCfg, originField, threat, mission.covered) : null), [mode, mission.phase, mission.covered, missionCfg, originField, threat]);
  const shownMission = idlePreview ?? mission;
  const missionCtx = useRef<MissionContext>({ prior: null, threat: null, origins: [], tracks: [] });
  missionCtx.current = { prior: originField, threat, origins: frame?.origins ?? [], tracks: frame?.tracks ?? [] };
  useEffect(() => {
    if (!missionOn) return;
    const id = window.setInterval(() => setMission((m) => {
      const rate = m.phase === 'flying' || m.phase === 'returning' ? MISSION_RATE_FLY : MISSION_RATE_DECIDE;
      return stepMission(m, rate * MISSION_TICK_S, missionCfgRef.current, missionCtx.current);
    }), MISSION_TICK_S * 1000);
    return () => window.clearInterval(id);
  }, [missionOn]);
  useEffect(() => { if (card.current) card.current.scrollTop = 0; }, [mission.phase]);
  const armSurvey = (operator: string) => setMission(armMission(initMission(missionCfg, originField, threat, mission.covered), operator));
  // Ranked next-survey suggestions (Lattice-style next action) from the live origin estimate, threat and mapped ground.
  const queue: SurveyOption[] = useMemo(() => (mode === 'survey' && frame ? surveyQueue(originField, threat, evidence.covered, DEFAULT_MISSION, frame.origins) : []), [mode, frame, originField, threat, evidence]);
  useEffect(() => { const c = mapRef.current?.getCanvas(); if (c) c.style.cursor = areaPick.on ? 'crosshair' : ''; }, [areaPick.on]);
  const routes = useMemo(() => (goal && threat ? planRoutes(threat, start, goal) : []), [threat, start, goal]);
  // Only the last DET_WINDOW_S seconds of detections: enough to show the fragments, bounded cost on the GPU.
  const dets = useMemo(() => s.frames.slice(Math.max(0, t - DET_WINDOW_S), t + 1).flatMap((f) => f.detections), [s, t]);
  const firstSeen = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of s.frames) for (const d of f.detections) if (d.truth_drone_id && !m.has(d.truth_drone_id) && !d.clutter) m.set(d.truth_drone_id, d.t);
    return m;
  }, [s]);

  // Drone state at this second; positions between seconds are interpolated in the animation loop (glideDrones).
  const drones: Drone[] = useMemo(() => {
    if (!frame) return [];
    const before = new Map(prev?.tracks.map((x) => [x.id, x.current]) ?? []);
    return frame.tracks.map((tr) => {
      const lost = tr.status === 'lost';
      const pv = before.get(tr.id);
      const t0 = tr.points[0]?.t ?? t;
      const tNow = lost ? (tr.points[tr.points.length - 1]?.t ?? t) : t;
      const fixes = tr.points.filter((q) => q.t <= t).length || tr.points.length;
      const conf = trackConfidence(fixes, tr.sensor_ids.length);
      const kind: Kind = lost ? 'lost' : affiliationOf(conf) === 'hostile' ? 'hostile' : 'unknown';
      return {
        id: tr.id, kind, conf, fixes, x: tr.current.x, y: tr.current.y, px: !lost && pv ? pv.x : tr.current.x, py: !lost && pv ? pv.y : tr.current.y,
        hdg: headingDeg(tr.current.vx, tr.current.vy), spd: speedMs(tr.current.vx, tr.current.vy), alt: agl(tNow, t0), palt: lost ? agl(tNow, t0) : agl(t - 1, t0), track: tr,
      };
    });
  }, [frame, prev, t]);

  // Tab 04 heat = what the drone has uploaded: mapped ground shows the danger it found (red) or clear (green), the
  // rest stays amber. Redrawn every SURVEY_HEAT_S mission seconds (about twice a second in flight), not every tick.
  const surveyTick = Math.floor(shownMission.clockS / SURVEY_HEAT_S);
  const surveyHeat = useMemo(() => {
    if (mode !== 'survey') return null;
    const u = uncertaintyGrid(shownMission);
    return threat ? revealFrame(threat, u, shownMission.covered) : heatFrame(u, 'unknown');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownMission is read on the throttled tick
  }, [mode, threat, idlePreview, surveyTick, shownMission.phase, shownMission.findings.length]);

  // ---- MapLibre: heat + draped vectors per tab ----
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !frame) return;
    let heat: HeatFrame | null = null;
    if (mode === 'enemy' && fusedOrigin) heat = heatFrame(lift(fusedOrigin, 0.55), 'threat'); // show the back-projected cones, not just the peaks
    if (mode === 'launch' && fusedLaunch) heat = heatFrame(lift(fusedLaunch, 0.5), 'safe'); // rank the whole box, not only the top sites
    if (mode === 'route' && threat) heat = heatFrame(threat, 'threat');
    if (mode === 'survey') heat = surveyHeat;
    setHeat(map, heat?.canvas ?? null, heat?.key ?? '', mode === 'enemy' ? 0.92 : 0.72); // wide-area tabs stay see-through

    // setData re-tiles in a worker, so only send sources whose contents actually changed.
    const set = (id: string, features: GeoJSON.Feature[]) => {
      const key = JSON.stringify(features);
      if (sent.current.get(id) === key) return;
      sent.current.set(id, key);
      (map.getSource(id) as GeoJSONSource).setData(fc(features));
    };
    set('rings', []); // sensor coverage is drawn in 3D by coverage.ts
    set('origins', mode === 'enemy' ? frame.origins.map((o) => poly([circleRing(o.peak.x, o.peak.y, o.radius_m, 48)])) : []);
    set('teams', mode === 'enemy' ? frame.launch_teams.filter((lt) => lt.origin_history.length > 1).map((lt) => line(lt.origin_history.map((h) => toLngLat(h.x, h.y)))) : []);
    set('sites', mode === 'launch' ? s.launch_site_options.map((o) => poly([circleRing(o.x, o.y, 300, 48)])) : []);
    const routeLines = routes.map((r, i) => line(r.points.map((q) => toLngLat(q.x, q.y)), { active: i === activeRoute }));
    set('routes', mode === 'route' ? [...routeLines.filter((f) => !f.properties?.active), ...routeLines.filter((f) => f.properties?.active)] : []);
    const rr = p.reconRoute;
    set('recon', rr && (mode === 'enemy' || mode === 'route') ? [line(rr.waypoints.map((q) => toLngLat(q.x, q.y))), ...(frame.recon ? [poly([circleRing(frame.recon.x, frame.recon.y, 1000, 48)])] : [])] : []);
  }, [ready, frame, mode, s, fusedOrigin, fusedLaunch, threat, routes, activeRoute, p.reconRoute, surveyHeat]);

  // ---- deck.gl: 3D objects ----
  const layers = useMemo(() => {
    if (!frame) return [];
    const at = (x: number, y: number, up = 0): [number, number, number] => [...toLngLat(x, y), elev(x, y) + up];
    const sel = frame.tracks.some((x) => x.id === p.selectedTrack) ? p.selectedTrack : null; // stale selection dims nothing
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
        getWidth: (d) => (d.id === sel ? 5 : 3), getColor: (d) => rgba(kindRGB(d.kind), dim(d.id)),
        updateTriggers: { getPath: elev, getColor: sel, getWidth: sel },
      }));
      out.push(new LineLayer({
        id: 'origin-stalks', data: frame.origins, widthUnits: 'pixels', getWidth: 2.5, getColor: rgba(RGB.origin),
        getSourcePosition: (o: { peak: Point }) => at(o.peak.x, o.peak.y), getTargetPosition: (o: { peak: Point }) => at(o.peak.x, o.peak.y, 260),
        updateTriggers: { getSourcePosition: elev, getTargetPosition: elev },
      }));
      // Backtrack: rays from where each drone was first seen to its triangulated launch site; a lone drone only has a
      // direction, drawn as the two edges of its cone (range unknown).
      const firstPt = new Map(frame.tracks.filter((tr) => tr.points.length).map((tr) => [tr.id, tr.points[0]]));
      const rays = frame.origins.filter((o) => isTriangulated(o) && firstPt.has(o.track_id));
      out.push(new LineLayer({
        id: 'backtrack-rays', data: rays, widthUnits: 'pixels', getWidth: 2, getColor: rgba(RGB.origin, 220),
        getSourcePosition: (o: OriginEstimate) => { const q = firstPt.get(o.track_id)!; return at(q.x, q.y, 40); },
        getTargetPosition: (o: OriginEstimate) => at(o.peak.x, o.peak.y, 40), updateTriggers: { getSourcePosition: elev, getTargetPosition: elev },
      }));
      const coneEdges = frame.tracks.filter((tr) => frame.origins.some((o) => o.track_id === tr.id && !isTriangulated(o)))
        .flatMap((tr) => { const c = conePoints(tr); return c ? [{ a: c.apex, b: c.left }, { a: c.apex, b: c.right }] : []; });
      out.push(new LineLayer({
        id: 'backtrack-cones', data: coneEdges, widthUnits: 'pixels', getWidth: 1.2, getColor: rgba(RGB.origin, 110),
        getSourcePosition: (e: { a: Point }) => at(e.a.x, e.a.y, 30), getTargetPosition: (e: { b: Point }) => at(e.b.x, e.b.y, 30),
        updateTriggers: { getSourcePosition: elev, getTargetPosition: elev },
      }));
      out.push(text('backtrack-agree', sitesOf(frame), {
        getPosition: (q: Site) => at(q.peak.x, q.peak.y, 380), getColor: rgba(RGB.origin),
        getText: (q: Site) => `${q.trackIds.length} DRONES AGREE ±${Math.round(q.radius_m)}M`, updateTriggers: { getPosition: elev },
      }));
      // One label per launch-team site (several tracks share a site); per-track origins only for the selection.
      const conf = new Map(frame.origins.map((o) => [o.track_id, o.confidence]));
      const sites = frame.launch_teams.flatMap((lt) => lt.origin_history.map((h, i) => ({
        x: h.x, y: h.y, label: `${lt.id} SITE ${i + 1}${lt.confirmed && i === lt.origin_history.length - 1 ? ' · CONFIRMED' : ` · ${pct(Math.max(0, ...lt.track_ids.map((id) => conf.get(id) ?? 0)))}`}`,
      })));
      out.push(text('site-labels-enemy', sites, {
        getPosition: (q: Point) => at(q.x, q.y, 300), getText: (q: { label: string }) => q.label, getColor: rgba(RGB.origin), updateTriggers: { getPosition: elev },
      }));
      // Confirmed enemy launch sites, from recon fusion and from this session's autonomous survey: NATO hostile site
      // symbols on a stalk with a tight ring at the confirmed position.
      const confirmed = [
        ...(frame.confirmed_sites ?? []).map((c) => ({ x: c.x, y: c.y, radius_m: c.radius_m, label: `${c.team_id} HOSTILE SITE CONFIRMED ±${Math.round(c.radius_m)}M` })),
        ...surveySites.map((f) => ({ x: f.x, y: f.y, radius_m: 150, label: `HOSTILE SITE · SURVEY-1 ${pct(f.confidence)}` })),
      ];
      out.push(new LineLayer({
        id: 'confirmed-stalks', data: confirmed, widthUnits: 'pixels', getWidth: 3, getColor: rgba(RGB.hostile),
        getSourcePosition: (c: Point) => at(c.x, c.y), getTargetPosition: (c: Point) => at(c.x, c.y, 420), updateTriggers: { getSourcePosition: elev, getTargetPosition: elev },
      }));
      out.push(new ScatterplotLayer({
        id: 'confirmed-rings', data: confirmed, radiusUnits: 'meters', getRadius: (c: { radius_m: number }) => Math.max(60, c.radius_m),
        stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 2.5, getLineColor: rgba(RGB.hostile),
        getPosition: (c: Point) => at(c.x, c.y, 10), updateTriggers: { getPosition: elev },
      }));
      out.push(new IconLayer({
        id: 'confirmed-symbols', data: confirmed, billboard: true, sizeUnits: 'pixels', getSize: 34, getIcon: () => natoIcon('hostile', 'site'),
        getPosition: (c: Point) => at(c.x, c.y, 420), updateTriggers: { getPosition: elev },
      }));
      out.push(text('confirmed-labels', confirmed, {
        getPosition: (c: Point) => at(c.x, c.y, 420), getColor: rgba(RGB.hostile), getPixelOffset: [0, -30],
        getText: (c: { label: string }) => c.label, updateTriggers: { getPosition: elev },
      }));
      const selO = frame.origins.filter((o) => o.track_id === sel);
      out.push(text('origin-labels', selO, {
        getPosition: (o: { peak: Point }) => at(o.peak.x, o.peak.y, 160), getColor: rgba(RGB.friendly), getPixelOffset: [0, 22],
        getText: (o: { track_id: string; confidence: number; radius_m: number }) => `${o.track_id} ORIGIN ${pct(o.confidence)} ±${Math.round(o.radius_m)}M`, updateTriggers: { getPosition: elev },
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

    if (mode === 'launch' || mode === 'route') {
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
        getText: (o: { r: { id: string; length_m: number; exposure_m: number; max_threat: number } }) => `ROUTE ${o.r.id} · ${km(o.r.length_m)} · EXPOSED ${km(o.r.exposure_m)} · PEAK ${pct(o.r.max_threat)}`,
        getColor: (o: { i: number }) => (o.i === activeRoute ? rgba(RGB.friendly) : rgba(RGB.allied)), updateTriggers: { getPosition: elev, getColor: activeRoute },
      }));
    }

    if (frame.recon && (mode === 'enemy' || mode === 'route') && p.reconRoute) {
      out.push(new PathLayer({
        id: 'survey-path', data: [p.reconRoute], widthUnits: 'pixels', getWidth: 2, billboard: true,
        getPath: (rr: ReconRoute) => densify(rr.waypoints).map((q) => at(q.x, q.y, SURVEY_AGL)), getColor: rgba(RGB.friendly, 170), updateTriggers: { getPath: elev },
      }));
    }
    return out;
  }, [frame, s, elev, mode, drones, dets, firstSeen, p.selectedTrack, p.reconRoute, start, goal, routes, activeRoute, surveySites]);

  // Per-frame layers: things that glide between simulated seconds or turn with the camera. Built inside the animation
  // loop below (no React re-render per frame); k is 0..1 through the current simulated second.
  const dynamic = useRef<(k: number) => Layer[]>(() => []);
  dynamic.current = (k) => {
    if (!frame) return [];
    const lead = (x: number, y: number, hdg: number, alt: number, m = 320) => { const h = (hdg * Math.PI) / 180; return atTerrain(x + m * Math.sin(h), y + m * Math.cos(h), alt); };
    const at = atTerrain;
    const sel = frame.tracks.some((x) => x.id === p.selectedTrack) ? p.selectedTrack : null;
    const out: Layer[] = [];
    const label = (id: string, data: unknown[], extra: Record<string, unknown>) => new TextLayer({
      id, data, fontFamily: FONT, fontWeight: 700, characterSet: 'auto', sizeUnits: 'pixels', getSize: 13,
      background: true, getBackgroundColor: [18, 17, 16, 220], backgroundPadding: [6, 3], billboard: true,
      getTextAnchor: 'start', getAlignmentBaseline: 'center', getPixelOffset: [34, 0], ...extra,
    });
    if (mode === 'enemy') {
      const g = drones.map((d) => ({ ...d, x: d.px + (d.x - d.px) * k, y: d.py + (d.y - d.py) * k, alt: d.palt + (d.alt - d.palt) * k }));
      const dim = (id: string) => sel && sel !== id;
      out.push(new LineLayer<Drone>({
        id: 'drop-lines', data: g, widthUnits: 'pixels', getWidth: 1.5,
        getSourcePosition: (d) => at(d.x, d.y, d.alt), getTargetPosition: (d) => at(d.x, d.y), getColor: (d) => rgba(RGB.friendly, dim(d.id) ? 40 : 150),
        updateTriggers: { getSourcePosition: [elev, k], getTargetPosition: [elev, k], getColor: sel },
      }));
      out.push(new ScatterplotLayer<Drone>({
        id: 'ground-marks', data: g, radiusUnits: 'meters', getRadius: 40, stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1.5,
        getPosition: (d) => at(d.x, d.y, 6), getFillColor: [0, 0, 0, 110], getLineColor: (d) => rgba(kindRGB(d.kind), 160),
        updateTriggers: { getPosition: [elev, k] },
      }));
      out.push(new LineLayer<Drone>({
        id: 'drone-heading', data: g.filter((d) => d.kind !== 'lost'), widthUnits: 'pixels', getWidth: 2.5,
        getSourcePosition: (d) => at(d.x, d.y, d.alt), getTargetPosition: (d) => lead(d.x, d.y, d.hdg, d.alt),
        getColor: (d) => rgba(kindRGB(d.kind), dim(d.id) ? 60 : 230),
        updateTriggers: { getSourcePosition: [elev, k], getTargetPosition: [elev, k], getColor: sel },
      }));
      out.push(new IconLayer<Drone>({
        id: 'drones', data: g, pickable: true, billboard: true, sizeUnits: 'pixels',
        getIcon: (d) => ICONS[d.kind], getSize: (d) => (d.id === sel ? 50 : 38), getPosition: (d) => at(d.x, d.y, d.alt),
        getColor: (d) => [255, 255, 255, d.kind === 'lost' ? 110 : dim(d.id) ? 90 : 255],
        updateTriggers: { getPosition: [elev, k], getSize: sel, getColor: sel },
      }));
      out.push(label('drone-labels', g, {
        getPosition: (d: Drone) => at(d.x, d.y, d.alt),
        getText: (d: Drone) => (d.kind === 'lost' ? `${d.id} LOST` : d.id === sel ? `${d.id} ${pct(d.conf)} · ${Math.round(d.spd)}M/S ${Math.round(d.alt)}M` : `${d.id} ${pct(d.conf)}`),
        getColor: (d: Drone) => rgba(kindRGB(d.kind), dim(d.id) ? 90 : 255),
        updateTriggers: { getPosition: [elev, k], getColor: sel, getText: sel },
      }));
    }
    const r = frame.recon;
    if (r && (mode === 'enemy' || mode === 'route')) {
      const before = prev?.recon?.route_id === r.route_id ? prev.recon : null;
      const rx = before ? before.x + (r.x - before.x) * k : r.x, ry = before ? before.y + (r.y - before.y) * k : r.y;
      const d = [{ id: r.route_id, x: rx, y: ry, hdg: before ? headingDeg(r.x - before.x, r.y - before.y) : 0, status: r.status, risk: r.risk_now }];
      out.push(new LineLayer({
        id: 'survey-drop', data: d, widthUnits: 'pixels', getWidth: 1.5, getColor: rgba(RGB.allied, 170),
        getSourcePosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), getTargetPosition: (q: Point) => at(q.x, q.y), updateTriggers: { getSourcePosition: [elev, k], getTargetPosition: [elev, k] },
      }));
      out.push(new LineLayer({
        id: 'survey-heading', data: d, widthUnits: 'pixels', getWidth: 2.5, getColor: rgba(RGB.allied, 230),
        getSourcePosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), getTargetPosition: (q: { x: number; y: number; hdg: number }) => lead(q.x, q.y, q.hdg, SURVEY_AGL),
        updateTriggers: { getSourcePosition: [elev, k], getTargetPosition: [elev, k] },
      }));
      out.push(new IconLayer({
        id: 'survey-drone', data: d, billboard: true, sizeUnits: 'pixels', getIcon: () => ICONS.friendly, getSize: 44,
        getPosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), updateTriggers: { getPosition: [elev, k] },
      }));
      out.push(label('survey-label', d, {
        getPosition: (q: Point) => at(q.x, q.y, SURVEY_AGL), getPixelOffset: [36, 0], getColor: rgba(RGB.allied),
        getText: (q: { id: string; status: string; risk: number }) => `${q.id} SURVEY · ${q.status.toUpperCase()} · RISK ${pct(q.risk)}`, updateTriggers: { getPosition: [elev, k] },
      }));
    }
    return out;
  };

  // One animation loop (~30 fps) composes coverage sweeps + slow layers + per-frame layers straight into deck.gl.
  const missionLs = useMemo(() => {
    if (mode !== 'survey') return [];
    const ls = missionLayers(shownMission, atTerrain, missionCfg);
    if (areaPick.corner) {
      ls.push(new ScatterplotLayer<Point>({
        id: 'area-corner', data: [areaPick.corner], getPosition: (q) => atTerrain(q.x, q.y, 6), getRadius: 90, radiusUnits: 'meters',
        stroked: true, filled: true, getFillColor: rgba(RGB.unknown, 90), getLineColor: rgba(RGB.unknown), lineWidthUnits: 'pixels', getLineWidth: 2,
      }));
    }
    return ls;
  }, [mode, shownMission, atTerrain, missionCfg, areaPick.corner]);
  const slow = useRef<Layer[]>([]);
  slow.current = missionLs.length ? [...layers, ...missionLs] : layers;
  const hidden = mode === 'provenance'; // the lineage view covers the map: stop drawing under it
  const anim = useRef({ playing: p.playing, sensors: s.sensors, at: atTerrain, focus: (mode === 'enemy' ? 'allied' : 'enemy') as 'allied' | 'enemy', hidden });
  anim.current = { playing: p.playing, sensors: s.sensors, at: atTerrain, focus: mode === 'enemy' ? 'allied' : 'enemy', hidden };
  const push = useCallback((now: number) => {
    const overlay = overlayRef.current, map = mapRef.current;
    if (!overlay || !map) return;
    const a = anim.current;
    if (a.hidden) { overlay.setProps({ layers: [] }); return; }
    const still = reduceMotion();
    const k = a.playing && !still ? Math.min(1, (now - tChangedAt.current) / STEP_MS) : 1;
    overlay.setProps({
      layers: [...coverageLayers(a.sensors, a.at, { focus: a.focus, timeMs: still ? 0 : now }), ...slow.current, ...dynamic.current(k)],
    });
  }, []);
  useEffect(() => { push(performance.now()); }); // after every React render (new second, tab, selection)
  useEffect(() => {
    if (reduceMotion()) return;
    let raf = 0, last = 0;
    const tick = (now: number) => {
      if (now - last >= 33) { last = now; push(now); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [push]);

  // ---- camera ----
  const cam = (o: { pitch?: number; bearing?: number }) => mapRef.current?.easeTo({ ...o, duration: 600 });
  const recenter = (bounds = activityBounds(s), zoomIn = OPENING_ZOOM_IN) => {
    const map = mapRef.current;
    if (!map) return;
    const { pitch: pt, bearing: br } = { pitch: map.getPitch(), bearing: map.getBearing() };
    const cam0 = map.cameraForBounds(bounds, { padding: framePadding(map) });
    if (cam0) map.easeTo({ ...cam0, zoom: (cam0.zoom ?? map.getZoom()) + (pt > 20 ? zoomIn : 0), pitch: pt, bearing: br, duration: 600 });
  };
  const flyTo = (q: Point) => mapRef.current?.flyTo({ center: toLngLat(q.x, q.y), zoom: 14, pitch: Math.max(50, pitch), duration: 1200 });

  const m = MODES.find((x) => x.id === mode)!;
  const selectMode = (id: OpsMode) => { setMode(id); setPickStart(false); if (id === 'survey' && mode !== 'survey') recenter(BOX_BOUNDS, 0); };
  // Keys 1–5 switch mission tabs, Esc clears the selected track (not while typing in a field).
  const selectModeRef = useRef(selectMode);
  useEffect(() => { selectModeRef.current = selectMode; });
  const onSelectTrack = p.onSelectTrack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input, textarea, select'))) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < MODES.length) { e.preventDefault(); selectModeRef.current(MODES[i].id); }
      if (e.key === 'Escape') onSelectTrack(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelectTrack]);
  const selTrack = frame?.tracks.find((x) => x.id === p.selectedTrack) ?? null;
  const selDrone = drones.find((d) => d.id === p.selectedTrack) ?? null;
  const selOrigin = frame?.origins.find((o) => o.track_id === p.selectedTrack) ?? null;
  const selTeam = frame?.launch_teams.find((lt) => lt.track_ids.includes(p.selectedTrack ?? '')) ?? null;

  return (
    <div className={hidden ? 'ops is-pv' : 'ops'}>
      <div ref={box} className="ops-map" />
      {hidden && <ProvenanceView scenario={s} t={t} onJump={p.onJump ?? noop} onSelectTrack={(id) => p.onSelectTrack(id)} />}

      <div className="ops-modes" role="tablist" aria-label="Map layer">
        {MODES.map((x) => (
          <button key={x.id} role="tab" aria-selected={mode === x.id} className={mode === x.id ? 'on' : ''} title={`${x.label} (key ${Number(x.code)})`}
            onClick={() => selectMode(x.id)}><span className="ops-mode-code">{x.code}</span>{x.label}</button>
        ))}
      </div>
      <div className="badge sim-badge">SIM // ALL DATA SIMULATED</div>
      {!hidden && <div className="hud-frame" aria-hidden="true"><i /><i /><i /><i /></div>}
      {!hidden && <div className="ops-ao" aria-label="Area of operations">AO <b>NTC FORT IRWIN</b> · 10 KM BOX · ILLUSTRATIVE PLACEMENT ON REAL TERRAIN</div>}

      {!hidden && (<>
      <section ref={card} className={`ops-card${cardOpen ? '' : ' is-collapsed'}`} aria-label={`${m.label} panel`}>
        <button className="ops-collapse" onClick={() => setCardOpen((v) => !v)} aria-expanded={cardOpen}>
          {cardOpen ? 'Hide panel' : `${m.label} panel`}
        </button>
        {cardOpen && (<>
        {mode === 'enemy' && (selTrack && selDrone ? (
          <>
            <div className="ops-card-head">
              <span className="micro">Track · {selDrone.kind === 'unknown' ? 'unknown air' : 'hostile air'}</span>
              <button className="ops-x" onClick={() => p.onSelectTrack(null)} aria-label="Close track card">✕</button>
            </div>
            <h2 className={`ops-title ${selDrone.kind === 'unknown' ? 'unknown' : 'hostile'}`}>{selTrack.id}<small>{selTrack.status === 'lost' ? 'LOST' : selDrone.kind === 'unknown' ? 'UNKNOWN' : 'HOSTILE'}</small></h2>
            <dl className="ops-data">
              <div><dt>Speed</dt><dd>{Math.round(selDrone.spd)} m/s</dd></div>
              <div><dt>Heading</dt><dd>{pad3(selDrone.hdg)}°</dd></div>
              <div><dt>Alt (sim)</dt><dd>{Math.round(selDrone.alt)} m AGL</dd></div>
              <div><dt>First fix</dt><dd>T+{pad3(selTrack.points[0]?.t ?? 0)}</dd></div>
              <div><dt>Sensors</dt><dd>{selTrack.sensor_ids.join(' ') || '–'}</dd></div>
              <div><dt>Team</dt><dd>{selTeam?.id ?? '–'}</dd></div>
            </dl>
            <EvidenceTrend scenario={s} trackId={selTrack.id} t={t} />
            {selOrigin && (
              <p className="ops-note">Launch origin near ({Math.round(selOrigin.peak.x / 10) * 10}, {Math.round(selOrigin.peak.y / 10) * 10}) m · {pct(selOrigin.confidence)} confidence · ±{Math.round(selOrigin.radius_m)} m</p>
            )}
            <button className="primary" onClick={() => flyTo(selDrone)}>Focus camera</button>
          </>
        ) : (
          <>
            <span className="micro">Air contacts · T+{pad3(t)}</span>
            {drones.length === 0 && <p className="ops-note">{p.playing ? 'Waiting for the first fused track.' : 'No tracks yet. Press play.'}</p>}
            <ul className="ops-list">
              {drones.map((d) => (
                <li key={d.id}><button onClick={() => { p.onSelectTrack(d.id); }}>
                  <b className={d.kind}>{d.id}</b>
                  <span>{d.kind === 'lost' ? 'LOST' : `${d.kind === 'unknown' ? 'UNK' : 'HOS'} ${pct(d.conf)} · ${d.fixes} FIX`}</span>
                  <ConfMeter value={d.kind === 'lost' ? 0 : d.conf} />
                </button></li>
              ))}
            </ul>
            <p className="ops-note">Contacts start UNKNOWN and turn HOSTILE as fixes and sensors add evidence. Click one for its evidence card.</p>
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
                  <span><em className="ok">{pct(o.concealment)}</em> concealed{o.distance_to_coverage_m != null ? ` · ${km(o.distance_to_coverage_m)} from coverage` : ''}</span>
                </button></li>
              ))}
            </ul>
            <p className="ops-note">Hardest places for enemy sensors to trace a launch back to. Click a site to fly there.</p>
          </>
        )}

        {mode === 'survey' && (
          <AutonomyPanel state={shownMission} playing={p.playing} maxRisk={DEFAULT_MISSION.maxRisk}
            onArm={armSurvey} onAbort={() => setMission(abortMission)} onReset={() => setMission((m) => initMission(missionCfg, null, null, m.covered))}
            areaLabel={surveyArea ? areaName(missionCfg) : 'Whole AO'} areaCustom={!!surveyArea} drawing={areaPick.on} cornerSet={!!areaPick.corner}
            canChangeArea={!missionOn} queue={queue} selectedOptionId={pickedId}
            onFullArea={() => chooseArea(null)} onDrawArea={() => setAreaPick({ on: true, corner: null })} onCancelDraw={() => setAreaPick({ on: false, corner: null })}
            onPickOption={(o) => chooseArea(o.area, o.id)} />
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
                  <span>{km(r.length_m)} · exposed {km(r.exposure_m)} · peak {pct(r.max_threat)}</span>
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
          {legendSwatches(m.palette).map((c, i) => <i key={i} style={{ background: c }} />)}
          <span>{m.high}</span>
        </div>
        {mode === 'survey' && (
          <div className="ops-ramp" aria-label="Mapped ground: danger level">
            <span>Mapped clear</span>
            <i style={{ background: legendSwatches('safe')[1] }} />
            {legendSwatches('threat').map((c, i) => <i key={i} style={{ background: c }} />)}
            <span>Danger</span>
          </div>
        )}
        {fusionNote && <span className="ops-fused">{fusionNote}</span>}
        <div className="ops-nato" aria-label="Symbol key">
          {NATO_KEY.map((a) => <span key={a}><i dangerouslySetInnerHTML={{ __html: natoSvg(a, 16) }} />{AFFIL[a].label}</span>)}
        </div>
      </div>

      <div className="ops-camera" aria-label="Camera">
        <button className={pitch < 5 ? 'on' : ''} onClick={() => cam({ pitch: 0, bearing: 0 })}>2D</button>
        <button className={pitch >= 5 ? 'on' : ''} onClick={() => cam({ pitch: 62, bearing: bearing || -20 })}>3D</button>
        <button onClick={() => cam({ bearing: bearing - 30 })} aria-label="Rotate left">⟲</button>
        <button onClick={() => cam({ bearing: bearing + 30 })} aria-label="Rotate right">⟳</button>
        <button onClick={() => cam({ pitch: Math.min(85, pitch + 10) })} aria-label="Tilt up">▲</button>
        <button onClick={() => cam({ pitch: Math.max(0, pitch - 10) })} aria-label="Tilt down">▼</button>
        <button onClick={() => (mode === 'survey' ? recenter(BOX_BOUNDS, 0) : recenter())} aria-label="Recenter">⌖</button>
        <output ref={camOut} className="ops-cam-readout">P{pad3(pitch)} B{pad3((bearing + 360) % 360)}</output>
      </div>
      </>)}
    </div>
  );
}
