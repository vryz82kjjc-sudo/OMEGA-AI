'use strict';
/*
 * ISOLATION FOREST vs RÍO vs SIMPLE sobre el banco NAB (datos reales, etiquetas
 * independientes). Mismas reglas de puntuación para los tres.
 *
 *   node river/nab-iforest.js <dir_raiz_NAB> <labels.json>
 *
 * Al Isolation Forest se le dan características CAUSALES por punto (solo pasado):
 * valor, desvío de la media reciente, dispersión reciente, salto y pendiente.
 */
const fs = require('fs');
const path = require('path');
const { RiverDetector } = require('./detector');
const { IsolationForest } = require('./iforest');

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

// --- scoring común ---
function auc(scores, times, wins) {
  const arr = scores.map((s, i) => ({ s, p: inWin(times[i], wins) }));
  const nP = arr.filter(a => a.p).length, nN = arr.length - nP; if (!nP || !nN) return null;
  arr.sort((a, b) => a.s - b.s); let sum = 0, i = 0;
  while (i < arr.length) { let j = i; while (j < arr.length && arr[j].s === arr[i].s) j++; const rk = (i + j + 1) / 2; for (let k = i; k < j; k++) if (arr[k].p) sum += rk; i = j; }
  return (sum - nP * (nP + 1) / 2) / (nP * nN);
}
function episodes(idx, gap = 10) { const ep = []; let s = null, p = null; for (const i of idx) { if (s === null) s = p = i; else if (i - p <= gap) p = i; else { ep.push([s, p]); s = p = i; } } if (s !== null) ep.push([s, p]); return ep; }
function recallFp(scores, times, wins, tau) {
  const idx = []; for (let i = 0; i < scores.length; i++) if (scores[i] >= tau) idx.push(i);
  const ep = episodes(idx); const hit = new Array(wins.length).fill(false); let fp = 0;
  for (const [a, b] of ep) { let io = false; for (let k = 0; k < wins.length; k++) if (times[b] >= wins[k][0] && times[a] <= wins[k][1]) { hit[k] = true; io = true; } if (!io) fp++; }
  return { det: hit.filter(Boolean).length, fp };
}
// mejor recall alcanzable con FP<=cap, barriendo el umbral propio de cada score
function bestAtFp(scores, times, wins, cap, lo, hi, step) {
  let best = 0; for (let tau = lo; tau <= hi; tau += step) { const r = recallFp(scores, times, wins, tau); if (r.fp <= cap && r.det > best) best = r.det; } return best;
}

// --- tres detectores: devuelven score por punto ---
function riverScores(values) { const d = new RiverDetector({ halfLife: 100, warmup: 200, rippleZ: 4, cusumH: 6, shiftCooldown: 50 }); return values.map(v => { const r = d.push(v); return r.ready ? Math.max(Math.abs(r.z) / 4, r.cusum / 6) : 0; }); }
function simpleScores(values, W = 200) { const sc = new Array(values.length).fill(0); for (let i = W; i < values.length; i++) { let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W; let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W); sc[i] = v > 1e-9 ? Math.abs(values[i] - m) / v / 4 : 0; } return sc; }
function iforestScores(values, W = 200) {
  const n = values.length, X = [];
  for (let i = 0; i < n; i++) {
    if (i < W) { X.push([values[i], 0, 0, 0, 0]); continue; }
    let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W;
    let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W);
    const diff = values[i] - values[i - 1];
    const slope = (values[i] - values[i - 10]) / 10;
    X.push([values[i], values[i] - m, v, diff, slope]);
  }
  const forest = new IsolationForest({ nTrees: 100, sampleSize: 256, seed: 7 }).fit(X.slice(W));
  const sc = new Array(n).fill(0);
  for (let i = W; i < n; i++) sc[i] = forest.score(X[i]);
  return sc;
}

function evalAll(name, scoreFn, lo, hi, step) {
  let aucs = [], d5 = 0, d10 = 0, d20 = 0;
  for (const s of series) {
    const sc = scoreFn(s.values);
    const a = auc(sc, s.times, s.wins); if (a != null) aucs.push(a);
    d5 += bestAtFp(sc, s.times, s.wins, 5, lo, hi, step);
    d10 += bestAtFp(sc, s.times, s.wins, 10, lo, hi, step);
    d20 += bestAtFp(sc, s.times, s.wins, 20, lo, hi, step);
  }
  const mAuc = aucs.reduce((a, b) => a + b, 0) / aucs.length;
  return { name, auc: mAuc, d5, d10, d20 };
}

console.log(`Series reales: ${series.length}  ·  ventanas etiquetadas: ${totalWin}\n`);
const results = [
  evalAll('Isolation Forest', iforestScores, 0.45, 0.80, 0.01),
  evalAll('RÍO', riverScores, 0.25, 3.0, 0.05),
  evalAll('Simple (z ventana)', simpleScores, 0.25, 3.0, 0.05),
];
console.log('detector'.padEnd(20) + ' | AUC   | det@FP≤5 | det@FP≤10 | det@FP≤20   (de ' + totalWin + ')');
console.log('-'.repeat(74));
for (const r of results) console.log(r.name.padEnd(20) + ' | ' + r.auc.toFixed(3) + ' |   ' + String(r.d5).padStart(2) + '     |    ' + String(r.d10).padStart(2) + '     |    ' + String(r.d20).padStart(2));
console.log('\nAUC = separación anomalía/normal (0.5 azar). det@FP = anomalías detectadas tolerando ese nº de falsos positivos. Más alto = mejor en ambos.');
