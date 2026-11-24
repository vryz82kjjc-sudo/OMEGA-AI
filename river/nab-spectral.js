'use strict';
/*
 * ¿Mejora leer "la ECUACIÓN de cada onda"? Añade características espectrales
 * (Fourier) al Isolation Forest y lo compara, sobre el banco NAB, con:
 *   - Isolation Forest espectral (estadísticas + firma de Fourier)
 *   - Isolation Forest básico (solo estadísticas)
 *   - RÍO
 *   - umbral simple
 *
 *   node river/nab-spectral.js <dir_raiz_NAB> <labels.json>
 */
const fs = require('fs');
const path = require('path');
const { RiverDetector } = require('./detector');
const { IsolationForest } = require('./iforest');
const { hann, spectralFeatures } = require('./spectral');

const ROOT = process.argv[2], LAB = process.argv[3];
const labels = JSON.parse(fs.readFileSync(LAB, 'utf8'));
const toMs = s => Date.parse(s.trim().replace(' ', 'T') + 'Z');

const series = [];
for (const cat of fs.readdirSync(ROOT)) {
  const cdir = path.join(ROOT, cat); if (!fs.statSync(cdir).isDirectory()) continue;
  for (const f of fs.readdirSync(cdir).filter(x => x.endsWith('.csv'))) {
    const key = cat + '/' + f; const wins = labels[key]; if (!wins) continue;
    const rows = fs.readFileSync(path.join(cdir, f), 'utf8').trim().split('\n').slice(1);
    const times = [], values = [];
    for (const r of rows) { const c = r.split(','); const t = toMs(c[0]); if (!isFinite(t)) continue; times.push(t); values.push(+c[1]); }
    series.push({ key, times, values, wins: wins.map(w => [toMs(w[0]), toMs(w[1])]) });
  }
}
const totalWin = series.reduce((a, s) => a + s.wins.length, 0);
const inWin = (t, w) => w.some(x => t >= x[0] && t <= x[1]);

function auc(sc, times, wins) { const a = sc.map((s, i) => ({ s, p: inWin(times[i], wins) })); const nP = a.filter(x => x.p).length, nN = a.length - nP; if (!nP || !nN) return null; a.sort((x, y) => x.s - y.s); let sum = 0, i = 0; while (i < a.length) { let j = i; while (j < a.length && a[j].s === a[i].s) j++; const rk = (i + j + 1) / 2; for (let k = i; k < j; k++) if (a[k].p) sum += rk; i = j; } return (sum - nP * (nP + 1) / 2) / (nP * nN); }
function episodes(idx, gap = 10) { const ep = []; let s = null, p = null; for (const i of idx) { if (s === null) s = p = i; else if (i - p <= gap) p = i; else { ep.push([s, p]); s = p = i; } } if (s !== null) ep.push([s, p]); return ep; }
function recallFp(sc, times, wins, tau) { const idx = []; for (let i = 0; i < sc.length; i++) if (sc[i] >= tau) idx.push(i); const ep = episodes(idx); const hit = new Array(wins.length).fill(false); let fp = 0; for (const [a, b] of ep) { let io = false; for (let k = 0; k < wins.length; k++) if (times[b] >= wins[k][0] && times[a] <= wins[k][1]) { hit[k] = true; io = true; } if (!io) fp++; } return { det: hit.filter(Boolean).length, fp }; }
function bestAtFp(sc, times, wins, cap, lo, hi, step) { let best = 0; for (let tau = lo; tau <= hi; tau += step) { const r = recallFp(sc, times, wins, tau); if (r.fp <= cap && r.det > best) best = r.det; } return best; }

// características estadísticas causales (como en nab-iforest)
function statFeat(values, W = 200) {
  const n = values.length, F = [];
  for (let i = 0; i < n; i++) {
    if (i < W) { F.push([values[i], 0, 0, 0, 0]); continue; }
    let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W;
    let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W);
    F.push([values[i], values[i] - m, v, values[i] - values[i - 1], (values[i] - values[i - 10]) / 10]);
  }
  return F;
}
const NF = 128, HANN = hann(NF);
function addSpectral(values, F) {
  for (let i = 0; i < values.length; i++) {
    if (i < NF) { F[i] = F[i].concat([0, 0, 1, 0, 0]); continue; }
    const s = spectralFeatures(values.slice(i - NF, i), HANN);
    F[i] = F[i].concat([s.energy, s.centroid, s.entropy, s.peak, s.lowFrac]);
  }
  return F;
}
function ifScores(F, W = 200) {
  const forest = new IsolationForest({ nTrees: 100, sampleSize: 256, seed: 7 }).fit(F.slice(W));
  const sc = new Array(F.length).fill(0);
  for (let i = W; i < F.length; i++) sc[i] = forest.score(F[i]);
  return sc;
}
function riverScores(values) { const d = new RiverDetector({ halfLife: 100, warmup: 200, rippleZ: 4, cusumH: 6, shiftCooldown: 50 }); return values.map(v => { const r = d.push(v); return r.ready ? Math.max(Math.abs(r.z) / 4, r.cusum / 6) : 0; }); }
function simpleScores(values, W = 200) { const sc = new Array(values.length).fill(0); for (let i = W; i < values.length; i++) { let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W; let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W); sc[i] = v > 1e-9 ? Math.abs(values[i] - m) / v / 4 : 0; } return sc; }

function evalAll(name, scoreFn, lo, hi, step) {
  let aucs = [], d5 = 0, d10 = 0, d20 = 0;
  for (const s of series) { const sc = scoreFn(s); const a = auc(sc, s.times, s.wins); if (a != null) aucs.push(a); d5 += bestAtFp(sc, s.times, s.wins, 5, lo, hi, step); d10 += bestAtFp(sc, s.times, s.wins, 10, lo, hi, step); d20 += bestAtFp(sc, s.times, s.wins, 20, lo, hi, step); }
  return { name, auc: aucs.reduce((a, b) => a + b, 0) / aucs.length, d5, d10, d20 };
}

console.log(`Series reales: ${series.length}  ·  ventanas etiquetadas: ${totalWin}\n`);
const results = [
  evalAll('IF espectral (Fourier)', s => ifScores(addSpectral(s.values, statFeat(s.values))), 0.45, 0.80, 0.01),
  evalAll('IF básico (solo stats)', s => ifScores(statFeat(s.values)), 0.45, 0.80, 0.01),
  evalAll('RÍO', s => riverScores(s.values), 0.25, 3.0, 0.05),
  evalAll('Simple (z ventana)', s => simpleScores(s.values), 0.25, 3.0, 0.05),
];
console.log('detector'.padEnd(24) + ' | AUC   | det@FP≤5 | det@FP≤10 | det@FP≤20   (de ' + totalWin + ')');
console.log('-'.repeat(80));
for (const r of results) console.log(r.name.padEnd(24) + ' | ' + r.auc.toFixed(3) + ' |   ' + String(r.d5).padStart(2) + '     |    ' + String(r.d10).padStart(2) + '     |    ' + String(r.d20).padStart(2));
console.log('\nAUC = separación anomalía/normal (0.5 azar). det@FP = anomalías detectadas por debajo de ese nº de falsos positivos (umbral óptimo por serie, optimista para todos por igual).');
