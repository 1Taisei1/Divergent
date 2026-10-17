// WGS84 lat/lon -> MGRS (Military Grid Reference System), e.g. "11S NV 54321 07654". Standard UTM transverse Mercator
// series; no Norway/Svalbard zone exceptions (not needed for the NTC box). Display only.
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';

export function toMGRS(lat: number, lon: number, digits = 5): string {
  if (lat < -80 || lat > 84) return 'OUTSIDE MGRS';
  const zone = Math.floor((lon + 180) / 6) + 1;
  const phi = (lat * Math.PI) / 180;
  const dl = ((lon - ((zone - 1) * 6 - 180 + 3)) * Math.PI) / 180;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan, C = EP2 * cos * cos, Ax = cos * dl;
  const M = A * ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi
    - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting = K0 * N * (Ax + ((1 - T + C) * Ax ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Ax ** 5) / 120) + 500000;
  let northing = K0 * (M + N * tan * (Ax ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * Ax ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Ax ** 6) / 720));
  if (lat < 0) northing += 10000000;

  const band = BANDS[Math.min(BANDS.length - 1, Math.floor((lat + 80) / 8))];
  const set = ((zone - 1) % 6) + 1;
  const col = COLS[(set - 1) % 3][Math.floor(easting / 100000) - 1] ?? '?';
  const row = ROWS[(Math.floor(northing / 100000) + (set % 2 === 0 ? 5 : 0)) % 20];
  const scale = 10 ** (5 - digits);
  const e = String(Math.floor((easting % 100000) / scale)).padStart(digits, '0');
  const n = String(Math.floor((northing % 100000) / scale)).padStart(digits, '0');
  return `${zone}${band} ${col}${row} ${e} ${n}`;
}
