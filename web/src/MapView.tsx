import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useState } from 'react';
import {
  Circle, CircleMarker, ImageOverlay, MapContainer, Marker, Pane, Polygon, Polyline, Rectangle, Tooltip, useMap, useMapEvents,
} from 'react-leaflet';
import { arrowHead, ellipsePolygon, gridBounds, gridImage, hasHeat, ll, llp, MAP_SIZE, pct, RAMPS } from './geo';
import type { Detection, Frame, ReconRoute, Scenario, Track, WhatIfRequest } from './types';

export const LAYERS = {
  grid: '1 km grid',
  sensors: 'Sensors + range',
  detections: 'Detections',
  clutter: 'Clutter',
  tracks: 'Tracks + uncertainty',
  origins: 'Origin estimates',
  originHeat: 'Origin heat map',
  forecast: 'Next-launch forecast',
  launchTeams: 'Launch-team moves',
  exposure: 'Enemy sensor coverage',
  routes: 'Friendly routes',
  suggestion: 'Sensor suggestion',
  recon: 'Survey route + drone',
} as const;
export type LayerKey = keyof typeof LAYERS;
export type Layers = Record<LayerKey, boolean>;
export const ALL_LAYERS = Object.fromEntries(Object.keys(LAYERS).map((k) => [k, true])) as Layers;

const BOUNDS: L.LatLngBoundsExpression = [ll(0, 0), ll(MAP_SIZE, MAP_SIZE)];
const C = { allied: '#4da3ff', enemy: '#ff4d4d', track: '#ffe14d', safe: '#3ddc84', amber: '#ffb020', dim: 0.15 };
const RISK = { low: C.safe, medium: C.amber, high: C.enemy };
const GRID_LINES = Array.from({ length: MAP_SIZE / 1000 + 1 }, (_, i) => i * 1000);

const plusIcon = L.divIcon({ className: '', html: '<div class="suggest-plus">+</div>', iconSize: [40, 40], iconAnchor: [20, 20] });
const droneIcon = L.divIcon({ className: '', html: '<div class="recon-diamond"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

export function frameAt(s: Scenario, t: number): Frame | undefined {
  return s.frames.find((f) => f.t === t) ?? s.frames[Math.min(Math.max(0, t), s.frames.length - 1)];
}

// Detections that fed a track: same sensors, and the drone the tracker associated with it (majority vote of the
// detections that sit on the track's own points).
function contributing(track: Track, dets: Detection[]): Set<string> {
  const byT = new Map(track.points.map((p) => [p.t, p]));
  const votes = new Map<string, number>();
  for (const d of dets) {
    const p = byT.get(d.t);
    if (!p || d.clutter || !d.truth_drone_id || !track.sensor_ids.includes(d.sensor_id)) continue;
    if (Math.hypot(d.x - p.x, d.y - p.y) <= Math.max(300, 4 * d.sigma_m)) votes.set(d.truth_drone_id, (votes.get(d.truth_drone_id) ?? 0) + 1);
  }
  const drone = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return new Set(dets.filter((d) => drone && d.truth_drone_id === drone && track.sensor_ids.includes(d.sensor_id)).map((d) => d.id));
}

type Props = {
  scenario: Scenario;
  t: number;
  layers: Layers;
  selectedTrack: string | null;
  onSelectTrack: (id: string | null) => void;
  reconRoute: ReconRoute | null;
  label?: string;
  // What-if controls (primary map only)
  onWhatIf?: (req: WhatIfRequest) => void;
  moveSensor?: string | null;
  onMoveSensor?: (id: string | null) => void;
};

export default function MapView(p: Props) {
  const { scenario: s, t, layers: on } = p;
  const frame = frameAt(s, t);
  const sensorsById = useMemo(() => new Map(s.sensors.map((x) => [x.id, x])), [s]);
  const dets = useMemo(() => s.frames.filter((f) => f.t <= t).flatMap((f) => f.detections), [s, t]);
  const sel = frame?.tracks.find((x) => x.id === p.selectedTrack) ?? null;
  const contrib = useMemo(() => (sel ? contributing(sel, dets) : null), [sel, dets]);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const dimSensor = (id: string) => (sel ? !sel.sensor_ids.includes(id) : false);

  return (
    <div className="map-wrap">
      <MapContainer crs={L.CRS.Simple} bounds={BOUNDS} minZoom={-5} maxZoom={2} zoomSnap={0.25} preferCanvas
        attributionControl={false} className="map">
        <FitOnResize />
        <MapEvents onClick={(x, y) => {
          setMenu(null);
          if (p.moveSensor && p.onWhatIf) {
            p.onWhatIf({ sensor_id: p.moveSensor, action: 'move', x: Math.round(x), y: Math.round(y) });
            p.onMoveSensor?.(null);
          } else p.onSelectTrack(null);
        }} />

        {on.grid && GRID_LINES.map((v) => (
          <span key={v}>
            <Polyline positions={[ll(v, 0), ll(v, MAP_SIZE)]} pathOptions={{ color: '#fff', opacity: 0.08, weight: 1 }} interactive={false} />
            <Polyline positions={[ll(0, v), ll(MAP_SIZE, v)]} pathOptions={{ color: '#fff', opacity: 0.08, weight: 1 }} interactive={false} />
          </span>
        ))}

        <Pane name="heat" style={{ zIndex: 350 }}>
          {on.exposure && hasHeat(frame?.exposure_grid) && (
            <ImageOverlay url={gridImage(frame.exposure_grid, RAMPS.exposure)} bounds={gridBounds(frame.exposure_grid)} />
          )}
          {on.forecast && hasHeat(frame?.forecast_heatmap) && (
            <ImageOverlay url={gridImage(frame.forecast_heatmap, RAMPS.forecast)} bounds={gridBounds(frame.forecast_heatmap)} />
          )}
          {on.originHeat && hasHeat(frame?.origin_heatmap) && (
            <ImageOverlay url={gridImage(frame.origin_heatmap, RAMPS.origin)} bounds={gridBounds(frame.origin_heatmap)} />
          )}
        </Pane>

        {on.routes && frame?.routes.map((r) => (
          <span key={r.id}>
            <Polyline positions={r.waypoints.map(llp)} pathOptions={{ color: RISK[r.risk_level], weight: 5, opacity: sel ? 0.3 : 0.9 }}>
              <Tooltip sticky>{`${r.id} · risk ${pct(r.risk)} (${r.risk_level})${r.exposed_by.length ? ` · seen by ${r.exposed_by.join(', ')}` : ''}`}</Tooltip>
            </Polyline>
            {r.safer_waypoints && (
              <Polyline positions={r.safer_waypoints.map(llp)} pathOptions={{ color: C.safe, weight: 4, dashArray: '12 10', opacity: sel ? 0.3 : 0.95 }}>
                <Tooltip sticky>{`Safer corridor for ${r.id}`}</Tooltip>
              </Polyline>
            )}
          </span>
        ))}

        {on.sensors && s.sensors.map((x) => {
          const color = x.side === 'allied' ? C.allied : C.enemy;
          const op = !x.active ? 0.25 : dimSensor(x.id) ? C.dim : 1;
          const hot = sel?.sensor_ids.includes(x.id);
          return (
            <span key={x.id}>
              <Circle center={ll(x.x, x.y)} radius={x.range_m} interactive={false}
                pathOptions={{ color, weight: hot ? 2.5 : 1, opacity: 0.6 * op, fillOpacity: (hot ? 0.12 : 0.05) * op, dashArray: x.active ? undefined : '6 6' }} />
              <CircleMarker center={ll(x.x, x.y)} radius={hot ? 11 : 8}
                pathOptions={{ color: '#fff', weight: hot ? 3 : 1.5, fillColor: color, fillOpacity: op, opacity: op }}
                eventHandlers={{
                  click: (e) => L.DomEvent.stopPropagation(e),
                  contextmenu: (e) => {
                    L.DomEvent.stopPropagation(e);
                    if (p.onWhatIf && x.side === 'allied') setMenu({ id: x.id, x: e.containerPoint.x, y: e.containerPoint.y });
                  },
                }}>
                <Tooltip direction="top" offset={[0, -8]}>{`${x.id} · ${x.type} · ${x.range_m} m${x.active ? '' : ' · disabled'}${p.onWhatIf && x.side === 'allied' ? ' · right-click for what-if' : ''}`}</Tooltip>
              </CircleMarker>
            </span>
          );
        })}

        {(on.detections || on.clutter) && dets.map((d) => {
          if (d.clutter ? !on.clutter : !on.detections) return null;
          const lit = contrib?.has(d.id);
          const op = d.clutter ? 0.35 : contrib ? (lit ? 1 : 0.12) : 0.85;
          return (
            <CircleMarker key={d.id} center={ll(d.x, d.y)} radius={d.clutter ? 3 : lit ? 4.5 : 3.5} interactive={false}
              pathOptions={{ stroke: false, fillColor: d.clutter ? '#8a8f98' : d.sensor_id === 'R1' ? '#ffffff' : '#7ff0ff', fillOpacity: sel && d.clutter ? 0.08 : op }} />
          );
        })}

        {sel && contrib && dets.filter((d) => contrib.has(d.id)).map((d) => {
          const sn = sensorsById.get(d.sensor_id);
          return sn ? (
            <Polyline key={`l-${d.id}`} positions={[ll(sn.x, sn.y), ll(d.x, d.y)]} interactive={false}
              pathOptions={{ color: C.allied, weight: 1, opacity: 0.45 }} />
          ) : null;
        })}

        {on.tracks && frame?.tracks.map((tr) => {
          const isSel = tr.id === p.selectedTrack;
          const op = sel && !isSel ? 0.2 : 1;
          const color = tr.status === 'lost' ? '#b0b0b0' : C.track;
          const pick = { click: (e: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); p.onSelectTrack(isSel ? null : tr.id); } };
          return (
            <span key={tr.id}>
              <Polygon positions={ellipsePolygon(tr)} pathOptions={{ color, weight: 1, opacity: 0.8 * op, fillOpacity: 0.15 * op }} eventHandlers={pick} />
              <Polyline positions={tr.points.map(llp)} pathOptions={{ color, weight: isSel ? 5 : 3, opacity: op, dashArray: tr.status === 'lost' ? '6 6' : undefined }} />
              <Polyline positions={tr.points.map(llp)} pathOptions={{ opacity: 0, weight: 18 }} eventHandlers={pick} />
              <CircleMarker center={ll(tr.current.x, tr.current.y)} radius={isSel ? 8 : 6} eventHandlers={pick}
                pathOptions={{ color: '#000', weight: 2, fillColor: color, fillOpacity: op, opacity: op }}>
                <Tooltip permanent direction="right" offset={[8, 0]} className="map-label">{`${tr.id}${tr.status === 'lost' ? ' (lost)' : ''}`}</Tooltip>
              </CircleMarker>
            </span>
          );
        })}

        {on.origins && frame?.origins.map((o) => (
          <span key={o.track_id}>
            <Circle center={llp(o.peak)} radius={o.radius_m} interactive={false}
              pathOptions={{ color: '#ff8a3d', weight: 1.5, dashArray: '4 6', fillOpacity: 0, opacity: sel && sel.id !== o.track_id ? 0.2 : 0.9 }} />
            <CircleMarker center={llp(o.peak)} radius={5} interactive={false} pathOptions={{ color: '#fff', weight: 1.5, fillColor: '#ff5a1f', fillOpacity: 1 }}>
              <Tooltip permanent direction="left" offset={[-8, 0]} className="map-label origin-label">{`${o.track_id} · ${pct(o.confidence)}`}</Tooltip>
            </CircleMarker>
          </span>
        ))}

        {on.launchTeams && frame?.launch_teams.map((lt) => {
          const h = lt.origin_history;
          return (
            <span key={lt.id}>
              <Polyline positions={h.map(llp)} pathOptions={{ color: '#ff8a3d', weight: 3, dashArray: '2 8' }} interactive={false} />
              {h.slice(1).map((pt, i) => (
                <Polygon key={i} positions={arrowHead(h[i], pt)} pathOptions={{ color: '#ff8a3d', fillColor: '#ff8a3d', fillOpacity: 1, weight: 1 }} interactive={false} />
              ))}
              <CircleMarker center={llp(h[h.length - 1])} radius={3} interactive={false} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
                <Tooltip permanent direction="bottom" offset={[0, 10]} className="map-label">{`${lt.id} · ${h.length} site${h.length > 1 ? 's' : ''}`}</Tooltip>
              </CircleMarker>
            </span>
          );
        })}

        {on.suggestion && s.sensor_suggestion && (
          <Marker position={ll(s.sensor_suggestion.x, s.sensor_suggestion.y)} icon={plusIcon}>
            <Tooltip direction="top" offset={[0, -18]} className="wide-tip">
              <b>Suggested sensor</b> · −{pct(s.sensor_suggestion.uncertainty_reduction)} uncertainty<br />{s.sensor_suggestion.reason}
            </Tooltip>
          </Marker>
        )}

        {on.recon && p.reconRoute && (
          <>
            <Rectangle bounds={[ll(p.reconRoute.geofence.x_min, p.reconRoute.geofence.y_min), ll(p.reconRoute.geofence.x_max, p.reconRoute.geofence.y_max)]}
              pathOptions={{ color: '#ffffff', weight: 1.5, dashArray: '3 6', fillOpacity: 0.03 }} interactive={false} />
            <Polyline positions={p.reconRoute.waypoints.map(llp)} pathOptions={{ color: '#ffffff', weight: 2.5, dashArray: '10 8', opacity: 0.85 }} interactive={false} />
          </>
        )}
        {on.recon && frame?.recon && (
          <Marker position={ll(frame.recon.x, frame.recon.y)} icon={droneIcon}>
            <Tooltip direction="top" offset={[0, -10]}>{`Survey drone ${frame.recon.route_id} · ${frame.recon.status} · risk ${pct(frame.recon.risk_now)}`}</Tooltip>
          </Marker>
        )}
      </MapContainer>

      <div className="badge sim-badge">SIMULATED DATA</div>
      {p.label && <div className="badge map-title">{p.label}</div>}
      {p.moveSensor && (
        <div className="badge move-hint">Click the map to move {p.moveSensor} · <button onClick={() => p.onMoveSensor?.(null)}>cancel</button></div>
      )}
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-title">What-if: {menu.id}</div>
          <button onClick={() => { p.onWhatIf?.({ sensor_id: menu.id, action: 'disable' }); setMenu(null); }}>Disable</button>
          <button onClick={() => { p.onMoveSensor?.(menu.id); setMenu(null); }}>Move here…</button>
        </div>
      )}
    </div>
  );
}

// Re-fit when the map's box changes size (e.g. the what-if split opens or closes).
function FitOnResize() {
  const map = useMap();
  useEffect(() => {
    const ro = new ResizeObserver(() => { map.invalidateSize(); map.fitBounds(BOUNDS); });
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function MapEvents({ onClick }: { onClick: (x: number, y: number) => void }) {
  useMapEvents({
    click: (e) => onClick(e.latlng.lng, e.latlng.lat),
    contextmenu: () => undefined,
  });
  return null;
}
