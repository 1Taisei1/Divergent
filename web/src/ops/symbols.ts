// NATO-style affiliation symbols (APP-6 / MIL-STD-2525 frame shapes and colours, as used by counter-UAS consoles):
// FRIEND = blue rectangle, HOSTILE = red diamond, NEUTRAL = green square, UNKNOWN = yellow quatrefoil. The frame says
// who it is; the glyph inside says what it is (a small quadcopter = UAS, a dot = ground site). Symbols stay upright;
// direction of movement is drawn as a separate leader line, as on a real common operating picture.
export type Affiliation = 'friend' | 'hostile' | 'neutral' | 'unknown';

// Stroke / fill per affiliation. These are the only colours used for affiliation anywhere in the 3D view.
export const AFFIL: Record<Affiliation, { stroke: string; fill: string; rgb: [number, number, number]; label: string }> = {
  friend: { stroke: '#5aa9ff', fill: '#0d2a44', rgb: [90, 169, 255], label: 'Friend' },
  hostile: { stroke: '#ff3b30', fill: '#4a0f0c', rgb: [255, 59, 48], label: 'Hostile' },
  neutral: { stroke: '#3fd68a', fill: '#0d3a24', rgb: [63, 214, 138], label: 'Neutral' },
  unknown: { stroke: '#ffd23f', fill: '#463a0c', rgb: [255, 210, 63], label: 'Unknown' },
};

// Frame outline in a -24..24 box.
const FRAME: Record<Affiliation, string> = {
  friend: '<rect x="-21" y="-14" width="42" height="28"/>',
  hostile: '<path d="M0 -21 L21 0 L0 21 L-21 0 Z"/>',
  neutral: '<rect x="-16" y="-16" width="32" height="32"/>',
  unknown: '<path d="M-8 -13 A8 8 0 0 1 8 -13 A8 8 0 0 1 13 -8 A8 8 0 0 1 13 8 A8 8 0 0 1 8 13 A8 8 0 0 1 -8 13 A8 8 0 0 1 -13 8 A8 8 0 0 1 -13 -8 A8 8 0 0 1 -8 -13 Z"/>',
};

const GLYPH = {
  uas: (c: string) => `<g stroke="${c}" stroke-width="1.8" fill="none"><path d="M-6 -6 L6 6 M6 -6 L-6 6"/>
    <circle cx="-6" cy="-6" r="2.6"/><circle cx="6" cy="-6" r="2.6"/><circle cx="-6" cy="6" r="2.6"/><circle cx="6" cy="6" r="2.6"/></g>`,
  site: (c: string) => `<circle r="4.5" fill="${c}"/>`,
  sensor: (c: string) => `<path d="M-6 6 L0 -7 L6 6" stroke="${c}" stroke-width="2" fill="none"/>`,
};
export type Glyph = keyof typeof GLYPH;

const cache = new Map<string, { id: string; url: string; width: number; height: number; anchorX: number; anchorY: number }>();
// deck.gl IconLayer icon definition (data-URL SVG, rendered at 2x for crisp edges).
export function natoIcon(a: Affiliation, glyph: Glyph = 'uas') {
  const id = `nato-${a}-${glyph}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const { stroke, fill } = AFFIL[a];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-24 -24 48 48">
    <g fill="${fill}" fill-opacity="0.85" stroke="#121110" stroke-width="5" stroke-linejoin="miter">${FRAME[a]}</g>
    <g fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linejoin="miter">${FRAME[a]}</g>${GLYPH[glyph](stroke)}</svg>`;
  const icon = { id, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 96, height: 96, anchorX: 48, anchorY: 48 };
  cache.set(id, icon);
  return icon;
}

// Small inline SVG for legends and lists (same shapes, CSS-sized).
export function natoSvg(a: Affiliation, size = 18): string {
  const { stroke, fill } = AFFIL[a];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-24 -24 48 48" aria-hidden="true"><g fill="${fill}" stroke="${stroke}" stroke-width="3.5">${FRAME[a]}</g></svg>`;
}

// Evidence-based classification for a track: a contact is UNKNOWN until enough independent fixes say it is a drone
// on a hostile course, then HOSTILE. Confidence climbs with each fix and with each extra sensor that saw it.
export const HOSTILE_AT = 0.5;
export function trackConfidence(fixes: number, sensors: number): number {
  const byFixes = 1 - Math.exp(-fixes / 4);
  const bySensors = 0.75 + 0.25 * Math.min(1, Math.max(0, sensors - 1) / 2);
  return Math.max(0, Math.min(0.99, byFixes * bySensors));
}
export const affiliationOf = (conf: number): Affiliation => (conf >= HOSTILE_AT ? 'hostile' : 'unknown');
