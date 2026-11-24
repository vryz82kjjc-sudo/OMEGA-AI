'use strict';
/*
 * ESTUDIO matemático de FALSOS vs VERDADEROS sobre datos reales (NAB).
 * Pregunta central: en el "score" del detector, ¿cuánto se SEPARAN los puntos
 * de anomalía real de los puntos normales? Esa separación (medida como AUC)
 * es lo que GOBIERNA el compromiso entre falsos positivos y detecciones.
 *
 *   node river/study.js <dir_raiz_NAB> <labels.json> [salida.json]
 *
 * Mide, para el RÍO y para un detector SIMPLE (z de ventana):
 *   - AUC de separación (prob. de que un punto de anomalía puntúe más que uno
 *     normal). 0.5 = no distingue; 1.0 = separación perfecta.
 *   - Curva ROC: recall (ventanas detectadas) vs falsos positivos, al barrer el
 *     umbral. Ambos con las MISMAS reglas y etiquetas.
 */
const fs = require('fs');
const path = require('path');
const { RiverDetector } = require('./detector');

const ROOT = process.argv[2], LAB = process.argv[3], OUT = process.argv[4] || null;
const labels = JSON.parse(fs.readFileSync(LAB, 'utf8'));
const toMs = s => Date.parse(s.trim().replace(' ', 'T') + 'Z');

// carga todas las series category/file.csv que tengan etiquetas
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

const inWindow = (t, wins) => wins.some(w => t >= w[0] && t <= w[1]);

// score continuo del RÍO: normalizado para que 1.0 = umbral de disparo
function riverScores(values) {
  const d = new RiverDetector({ halfLife: 100, warmup: 200, rippleZ: 4, cusumH: 6, shiftCooldown: 50 });
  const sc = [];
  for (let i = 0; i < values.length; i++) {
    const r = d.push(values[i]);
    sc.push(r.ready ? Math.max(Math.abs(r.z) / 4, r.cusum / 6) : 0);
  }
  return sc;
}
// score del SIMPLE: |z| de ventana móvil, normalizado igual (z=4 -> 1.0)
function baselineScores(values, W = 200) {
  const sc = new Array(values.length).fill(0);
  for (let i = W; i < values.length; i++) {
    let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W;
    let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W);
    sc[i] = v > 1e-9 ? Math.abs(values[i] - m) / v / 4 : 0;
  }
  return sc;
}

// AUC (Mann-Whitney) sobre puntos normales vs anomalía
function auc(scores, times, wins) {
  const pos = [], neg = [];
  for (let i = 0; i < scores.length; i++) (inWindow(times[i], wins) ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return null;
  const all = scores.map((s, i) => ({ s, p: inWindow(times[i], wins) })).sort((a, b) => a.s - b.s);
  let rank = 0, sumPos = 0, i = 0;
  while (i < all.length) { let j = i; while (j < all.length && all[j].s === all[i].s) j++; const avg = (i + j + 1) / 2; for (let k = i; k < j; k++) if (all[k].p) sumPos += avg; i = j; }
  const nP = pos.length, nN = neg.length;
  return (sumPos - nP * (nP + 1) / 2) / (nP * nN);
}

// episodios y recall/FP a un umbral dado
function episodes(idx, gap = 10) { const ep = []; let s = null, p = null; for (const i of idx) { if (s === null) s = p = i; else if (i - p <= gap) p = i; else { ep.push([s, p]); s = p = i; } } if (s !== null) ep.push([s, p]); return ep; }
function recallFp(scores, times, wins, tau) {
  const idx = []; for (let i = 0; i < scores.length; i++) if (scores[i] >= tau) idx.push(i);
  const ep = episodes(idx); const hit = new Array(wins.length).fill(false); let fp = 0;
  for (const [a, b] of ep) { let io = false; for (let k = 0; k < wins.length; k++) if (times[b] >= wins[k][0] && times[a] <= wins[k][1]) { hit[k] = true; io = true; } if (!io) fp++; }
  return { det: hit.filter(Boolean).length, tot: wins.length, fp };
}

// --- cálculo por detector ---
function analyze(scoreFn) {
  let aucs = [];
  const perSeries = [];
  const scoresAll = series.map(s => scoreFn(s.values));
  for (let si = 0; si < series.length; si++) {
    const a = auc(scoresAll[si], series[si].times, series[si].wins);
    if (a != null) aucs.push(a);
    perSeries.push({ key: series[si].key, auc: a });
  }
  // ROC agregada
  const taus = []; for (let t = 0.25; t <= 3.01; t += 0.05) taus.push(+t.toFixed(2));
  const roc = taus.map(tau => {
    let det = 0, tot = 0, fp = 0;
    for (let si = 0; si < series.length; si++) { const r = recallFp(scoresAll[si], series[si].times, series[si].wins, tau); det += r.det; tot += r.tot; fp += r.fp; }
    return { tau, det, tot, fp };
  });
  const meanAuc = aucs.reduce((a, b) => a + b, 0) / aucs.length;
  return { meanAuc, perSeries, roc };
}

const river = analyze(riverScores);
const base = analyze(baselineScores);
const totalWin = series.reduce((a, s) => a + s.wins.length, 0);

console.log(`Series reales: ${series.length}  ·  ventanas de anomalía etiquetadas: ${totalWin}\n`);
console.log('AUC de separación (1.0=perfecto, 0.5=azar):');
console.log(`   RÍO    : ${river.meanAuc.toFixed(3)}`);
console.log(`   SIMPLE : ${base.meanAuc.toFixed(3)}`);
// recall a FP comparables (<= ~15)
function atFp(roc, maxFp) { let best = { det: 0, fp: 0, tau: 0 }; for (const p of roc) if (p.fp <= maxFp && p.det >= best.det) best = p; return best; }
for (const cap of [5, 10, 20]) {
  const r = atFp(river.roc, cap), b = atFp(base.roc, cap);
  console.log(`A <=${cap} falsos positivos:  RÍO ${r.det}/${totalWin}  |  SIMPLE ${b.det}/${totalWin}`);
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ totalWin, nSeries: series.length, river, base }, null, 2)); console.log('\nJSON del estudio -> ' + OUT); }
