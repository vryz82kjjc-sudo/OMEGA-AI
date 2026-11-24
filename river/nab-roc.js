'use strict';
/*
 * COMPARACIÓN JUSTA (curva recall vs falsos positivos) sobre NAB.
 * Un solo punto engaña: el detector más sensible detecta más y se equivoca
 * más. Lo honesto es barrer la sensibilidad de AMBOS y comparar la curva. Un
 * detector es mejor si, a IGUAL número de falsos positivos, detecta más.
 *
 *   node river/nab-roc.js <dir_datos> <labels.json>
 */
const fs = require('fs');
const path = require('path');
const { RiverDetector } = require('./detector');

const DIR = process.argv[2], LAB = process.argv[3];
const labels = JSON.parse(fs.readFileSync(LAB, 'utf8'));
const toMs = s => Date.parse(s.trim().replace(' ', 'T') + 'Z');

const series = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.csv'))) {
  const key = 'realKnownCause/' + f; const wins = labels[key]; if (!wins) continue;
  const rows = fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').slice(1);
  const times = [], values = [];
  for (const r of rows) { const c = r.split(','); const t = toMs(c[0]); if (!isFinite(t)) continue; times.push(t); values.push(+c[1]); }
  series.push({ times, values, wins: wins.map(w => [toMs(w[0]), toMs(w[1])]) });
}

function episodes(idx, gap = 10) { const ep = []; let s = null, p = null; for (const i of idx) { if (s === null) s = p = i; else if (i - p <= gap) p = i; else { ep.push([s, p]); s = p = i; } } if (s !== null) ep.push([s, p]); return ep; }
function score(fires, times, wins) {
  const ep = episodes(fires); const hit = new Array(wins.length).fill(false); let fp = 0;
  for (const [a, b] of ep) { const ta = times[a], tb = times[b]; let io = false; for (let k = 0; k < wins.length; k++) if (tb >= wins[k][0] && ta <= wins[k][1]) { hit[k] = true; io = true; } if (!io) fp++; }
  return { det: hit.filter(Boolean).length, fp };
}
const baseline = (values, Z) => { const W = 200, out = []; for (let i = W; i < values.length; i++) { let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W; let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W); const z = v > 1e-9 ? (values[i] - m) / v : 0; if (Math.abs(z) >= Z) out.push(i); } return out; };
const river = (values, k) => { const d = new RiverDetector({ halfLife: 100, warmup: 200, rippleZ: k, cusumH: k + 2, shiftCooldown: 50 }); const out = []; for (let i = 0; i < values.length; i++) { const r = d.push(values[i]); if (r.ready && (r.ripple || r.shift)) out.push(i); } return out; };

function curve(label, run, knobs) {
  console.log('\n' + label);
  for (const k of knobs) {
    let det = 0, tot = 0, fp = 0;
    for (const s of series) { const r = score(run(s.values, k), s.times, s.wins); det += r.det; tot += r.wins ? 0 : 0; fp += r.fp; det; }
    // recompute tot once
    tot = series.reduce((a, s) => a + s.wins.length, 0);
    console.log(`  knob=${k}\t detectadas ${det}/${tot}\t falsos positivos ${fp}`);
  }
}
curve('=== DETECTOR SIMPLE (z-score ventana) — knob = umbral Z ===', baseline, [3, 3.5, 4, 4.5, 5, 6, 7]);
curve('=== RÍO — knob = rippleZ (cusumH=knob+2) ===', river, [4, 5, 6, 7, 8, 10, 12]);
console.log('\nComparación justa: a un número de FALSOS POSITIVOS parecido, ¿quién detecta más anomalías?');
