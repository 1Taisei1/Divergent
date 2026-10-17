// @ts-nocheck -- Node-only dev check, not imported by the app (the app's tsconfig has no Node types).
// Runs every analytics field at t = 30 / 60 / 90 on flat terrain (elev = null), prints timings and a coarse ASCII map
// (north up; A = allied sensor, E = enemy sensor, H = home base) plus how much of each field lies outside every sensor ring.
//   curl -s --compressed http://localhost:8000/scenario/demo -o demo.json
//   node --experimental-strip-types web/src/ops/analytics.check.mts demo.json
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// The app's imports are extensionless (Vite resolves them); teach Node to retry relative specifiers with ".ts".
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) { if (/^\\.{1,2}\\//.test(spec) && !/\\.[cm]?[jt]sx?$/.test(spec)) return next(spec + '.ts', ctx); throw e; }
}`));
const A = await import('./analytics.ts');

const file = process.argv[2];
if (!file) { console.error('usage: node --experimental-strip-types analytics.check.mts <scenario.json>'); process.exit(1); }
const s = JSON.parse(readFileSync(file, 'utf8'));
const HOME = { x: 8500, y: 1000 };

function time(label, fn) {
  const t0 = performance.now();
  const out = fn();
  console.log(`  ${label.padEnd(34)} ${(performance.now() - t0).toFixed(1).padStart(7)} ms`);
  return out;
}

function stats(g) {
  let max = 0, mass = 0, outside = 0, cells = 0;
  for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
    const v = g.values[r][c], x = (c + 0.5) * g.cell_m, y = (r + 0.5) * g.cell_m;
    max = Math.max(max, v); mass += v;
    if (v > 0.1) cells++;
    if (!s.sensors.some((q) => q.active && Math.hypot(x - q.x, y - q.y) < q.range_m)) outside += v;
  }
  return `max ${max.toFixed(2)}  cells>0.1: ${cells}  mass outside every sensor ring: ${mass ? ((100 * outside) / mass).toFixed(0) : 0}%`;
}

function ascii(title, g) {
  console.log(`\n  ${title}   [${stats(g)}]`);
  const W = 50, H = 25, sx = g.width / W, sy = g.height / H;
  const marks = new Map();
  const mark = (x, y, ch) => marks.set(`${Math.floor(x / g.cell_m / sx)},${Math.floor(y / g.cell_m / sy)}`, ch);
  for (const q of s.sensors) mark(q.x, q.y, q.side === 'allied' ? 'A' : 'E');
  mark(HOME.x, HOME.y, 'H');
  for (let j = H - 1; j >= 0; j--) {
    let line = '  |';
    for (let i = 0; i < W; i++) {
      let v = 0;
      for (let r = Math.floor(j * sy); r < Math.floor((j + 1) * sy); r++) for (let c = Math.floor(i * sx); c < Math.floor((i + 1) * sx); c++) v = Math.max(v, g.values[r][c]);
      line += marks.get(`${i},${j}`) ?? (v >= 0.66 ? '#' : v >= 0.33 ? '+' : v >= 0.1 ? '.' : ' ');
    }
    console.log(line + '|');
  }
}

console.log(`scenario ${s.id}: ${s.sensors.length} sensors, ${s.frames.length} frames`);
const allied = time('detectionField allied (cold)', () => A.detectionField(s.sensors, 'allied', null));
const enemy = time('detectionField enemy (cold)', () => A.detectionField(s.sensors, 'enemy', null));
time('detectionField enemy (memo hit)', () => A.detectionField(s.sensors, 'enemy', null));
ascii('ALLIED detection P (elev null)', allied);
ascii('ENEMY detection P (elev null)', enemy);

for (const t of [30, 60, 90]) {
  console.log(`\n=== t = ${t} s ===`);
  const act = time('hostileActivityField', () => A.hostileActivityField(s, t));
  const org = time('enemyOriginField', () => A.enemyOriginField(s, t, allied));
  const safe = time('safeLaunchField', () => A.safeLaunchField(s, t, enemy, act, null));
  const threat = time('routeThreatField', () => A.routeThreatField(enemy, act, org));
  time('all four again (memo hits)', () => {
    A.routeThreatField(enemy, A.hostileActivityField(s, t), A.enemyOriginField(s, t, allied));
    A.safeLaunchField(s, t, enemy, A.hostileActivityField(s, t), null);
  });
  ascii(`HOSTILE ACTIVITY t=${t}`, act);
  ascii(`ENEMY ORIGINS t=${t}`, org);
  ascii(`SAFE LAUNCH t=${t}`, safe);
  ascii(`ROUTE THREAT t=${t}`, threat);
}

// Synthetic ridged terrain (true m x 1.4, like geo3d's ElevationFn) to time the line-of-sight paths too.
const ridges = (x, y) => 1.4 * (600 + 90 * Math.sin(x / 700) * Math.cos(y / 1100) + 0.02 * x);
console.log('\n=== synthetic terrain (timing of LOS paths) ===');
const enemyT = time('detectionField enemy + LOS (cold)', () => A.detectionField(s.sensors, 'enemy', ridges));
time('detectionField allied + LOS (cold)', () => A.detectionField(s.sensors, 'allied', ridges));
const act90 = A.hostileActivityField(s, 90);
time('safeLaunchField + terrain mask (cold)', () => A.safeLaunchField(s, 90, enemyT, act90, ridges));
time('safeLaunchField + terrain (t=91, warm)', () => A.safeLaunchField(s, 91, enemyT, A.hostileActivityField(s, 91), ridges));
ascii('ENEMY detection P with ridges', enemyT);
