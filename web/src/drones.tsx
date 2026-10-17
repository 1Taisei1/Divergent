// Drone sprites and HUD pieces for the operator map: quadcopters that face their heading and glide between
// simulated seconds, radar sweeps, launch-site reticles, a cursor readout and a scale bar.
import L from 'leaflet';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Marker, SVGOverlay, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { ll } from './geo';
import type { Sensor } from './types';

// One simulated second lasts 250 ms at 4x playback (App.tsx), so a drone glides one second's travel in that time.
export const STEP_MS = 250;

export const HUD = {
  hostile: '#f0332b',
  lost: '#8f8a84',
  friendly: '#eeeae2',
  allied: '#5aa9ff',
  ink: '#121110',
  origin: '#ffb02e',
};

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// Heading in degrees clockwise from north (map +y), the way CSS rotate() turns on screen.
export const headingDeg = (vx: number, vy: number) => ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
export const speedMs = (vx: number, vy: number) => Math.hypot(vx, vy);
export const pad3 = (n: number) => String(Math.round(n)).padStart(3, '0');

export type DroneKind = 'hostile' | 'lost' | 'friendly';

// SVG rotation about an explicit centre (SMIL), so it behaves the same inside divIcons and overlays.
const spin = (cx: number, cy: number, seconds: number, ccw = false) =>
  `<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="${ccw ? -360 : 360} ${cx} ${cy}" dur="${seconds}s" repeatCount="indefinite"/>`;

// Top-down quadcopter, nose up. Rotor blades spin while airborne; the whole sprite turns with --hdg.
function quadSvg(kind: DroneKind): string {
  const c = kind === 'hostile' ? HUD.hostile : kind === 'lost' ? HUD.lost : HUD.friendly;
  const rotor = kind === 'friendly' ? HUD.allied : c;
  const spinning = kind !== 'lost' && !reduceMotion();
  const rotors = [[-11, -11], [11, -11], [-11, 11], [11, 11]]
    .map(([x, y], i) => `
      <circle cx="${x}" cy="${y}" r="7.5" fill="${HUD.ink}" fill-opacity="0.55" stroke="${rotor}" stroke-width="1.6"/>
      <g>
        <line x1="${x - 6}" y1="${y}" x2="${x + 6}" y2="${y}" stroke="${rotor}" stroke-width="2.2" stroke-linecap="square"/>
        ${spinning ? spin(x, y, 0.3, i % 2 === 1) : ''}
      </g>`)
    .join('');
  return `
    <svg class="quad quad-${kind}" viewBox="-22 -22 44 44" width="44" height="44" aria-hidden="true">
      <g class="quad-frame">
        <path d="M-11 -11 L11 11 M11 -11 L-11 11" stroke="${HUD.ink}" stroke-width="6"/>
        <path d="M-11 -11 L11 11 M11 -11 L-11 11" stroke="${c}" stroke-width="3"/>
        ${rotors}
        <rect x="-5" y="-6" width="10" height="12" fill="${c}" stroke="${HUD.ink}" stroke-width="1.5"/>
        <path d="M0 -14 L-4 -8 L4 -8 Z" fill="${c}" stroke="${HUD.ink}" stroke-width="1"/>
      </g>
    </svg>`;
}

const iconCache = new Map<DroneKind, L.DivIcon>();
export function droneIcon(kind: DroneKind): L.DivIcon {
  let icon = iconCache.get(kind);
  if (!icon) {
    icon = L.divIcon({ className: `drone-icon drone-${kind}`, html: quadSvg(kind), iconSize: [44, 44], iconAnchor: [22, 22] });
    iconCache.set(kind, icon);
  }
  return icon;
}

type DroneProps = {
  kind: DroneKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  from?: { x: number; y: number } | null; // last second's position, to glide from while playing
  playing: boolean;
  dim?: boolean;
  label: ReactNode;
  labelClass?: string;
  onClick?: () => void;
};

// A drone marker positioned imperatively, so playback can glide it with requestAnimationFrame without re-rendering
// the rest of the map 60 times a second.
export function DroneMarker({ kind, x, y, vx, vy, from, playing, dim, label, labelClass, onClick }: DroneProps) {
  const ref = useRef<L.Marker>(null);
  const [initial] = useState(() => ll(x, y)); // react-leaflet only reads this once; the effect below moves the marker
  const moving = kind !== 'lost' && speedMs(vx, vy) > 0.5;
  const hdg = headingDeg(vx, vy);

  useEffect(() => {
    const el = ref.current?.getElement();
    if (!el) return;
    if (moving) el.style.setProperty('--hdg', `${hdg}deg`);
    el.classList.toggle('is-dim', !!dim);
    ref.current?.getTooltip()?.getElement()?.classList.toggle('is-dim', !!dim);
  }, [hdg, moving, dim]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const to = ll(x, y);
    if (!playing || !from || !moving || reduceMotion()) { m.setLatLng(to); return; }
    const f = ll(from.x, from.y);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / STEP_MS);
      m.setLatLng([f[0] + (to[0] - f[0]) * k, f[1] + (to[1] - f[1]) * k]);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // `from` changes together with x/y; reading it here is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, playing, moving]);

  return (
    <Marker ref={ref} position={initial} icon={droneIcon(kind)} zIndexOffset={kind === 'friendly' ? 900 : 800}
      eventHandlers={onClick ? { click: (e) => { L.DomEvent.stopPropagation(e); onClick(); } } : undefined}>
      <Tooltip permanent direction="right" offset={[22, 0]} className={`map-label drone-label ${labelClass ?? ''}`}>{label}</Tooltip>
    </Marker>
  );
}

// Ground sensor: a square station glyph with its id. The range circle is drawn separately.
const sensorCache = new Map<string, L.DivIcon>();
export function sensorIcon(s: Sensor, hot: boolean): L.DivIcon {
  const key = `${s.id}|${s.side}|${s.type}|${s.active}|${hot}`;
  let icon = sensorCache.get(key);
  if (!icon) {
    const code = s.type === 'radar' ? 'RAD' : s.type === 'acoustic' ? 'ACO' : 'RF';
    icon = L.divIcon({
      className: `sensor-icon side-${s.side}${s.active ? '' : ' is-off'}${hot ? ' is-hot' : ''}`,
      html: `<span class="sensor-id">${s.id}</span><span class="sensor-type">${code}</span>`,
      iconSize: [46, 38],
      iconAnchor: [23, 19],
    });
    sensorCache.set(key, icon);
  }
  return icon;
}

// Rotating radar sweep scaled to the sensor's range. Drawn as an SVG overlay so it zooms with the map.
export function RadarSweep({ s }: { s: Sensor }) {
  const color = s.side === 'allied' ? HUD.allied : HUD.hostile;
  const r = s.range_m;
  return (
    <SVGOverlay bounds={[ll(s.x - r, s.y - r), ll(s.x + r, s.y + r)]} attributes={{ viewBox: '-1 -1 2 2', class: 'sweep-overlay' }} interactive={false}>
      <g>
        <path d="M0 0 L0 -1 A1 1 0 0 0 -0.6 -0.8 Z" fill={color} fillOpacity="0.16" />
        <line x1="0" y1="0" x2="0" y2="-1" stroke={color} strokeOpacity="0.75" strokeWidth="0.012" />
        {!reduceMotion() && <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="4s" repeatCount="indefinite" />}
      </g>
    </SVGOverlay>
  );
}

// Estimated launch site: a broken-ring reticle with a centre dot.
const reticles = new Map<boolean, L.DivIcon>();
export const reticleIcon = (faded: boolean) => reticles.get(faded) ?? reticles.set(faded, makeReticle(faded)).get(faded)!;
const makeReticle = (faded: boolean) => L.divIcon({
  className: `reticle${faded ? ' is-faded' : ''}`,
  html: `<svg viewBox="-17 -17 34 34" width="34" height="34" aria-hidden="true">
    <circle r="11" fill="none" stroke="${HUD.ink}" stroke-width="5"/>
    <circle r="11" fill="none" stroke="${HUD.origin}" stroke-width="2.4" stroke-dasharray="12 5.3"/>
    <path d="M0 -16 V-8 M0 8 V16 M-16 0 H-8 M8 0 H16" stroke="${HUD.origin}" stroke-width="2"/>
    <rect x="-2.5" y="-2.5" width="5" height="5" fill="${HUD.origin}"/>
  </svg>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

// Live map-coordinate readout under the cursor, written straight to the DOM (no React re-render per mouse move).
export function CursorReadout() {
  const box = useRef<HTMLDivElement>(null);
  useMapEvents({
    mousemove: (e) => {
      if (box.current) box.current.textContent = `X ${String(Math.round(e.latlng.lng)).padStart(5, '0')}  Y ${String(Math.round(e.latlng.lat)).padStart(5, '0')} M`;
    },
    mouseout: () => { if (box.current) box.current.textContent = 'X ·····  Y ····· M'; },
  });
  return <div ref={box} className="hud-readout" aria-hidden="true">X ·····  Y ····· M</div>;
}

// Metric scale bar (CRS.Simple units are meters).
export function ScaleBar() {
  const map = useMap();
  useEffect(() => {
    const c = L.control.scale({ imperial: false, position: 'bottomright', maxWidth: 160 });
    c.addTo(map);
    return () => { c.remove(); };
  }, [map]);
  return null;
}
