'use strict';
/*
 * EVALUACIÓN HONESTA sobre NAB (Numenta Anomaly Benchmark): series reales con
 * anomalías etiquetadas de forma INDEPENDIENTE. Compara el RÍO contra un
 * detector SIMPLE (z-score de ventana móvil), puntuando ambos contra las mismas
 * etiquetas. Objetivo: ¿la maquinaria del río (CUSUM, Huber, robustez) aporta
 * algo frente a un umbral simple, en datos que yo no fabriqué?
 *
 *   node river/nab-eval.js <dir_datos> <labels.json>
 *
 * Reglas de puntuación (iguales para ambos, sin trampa):
 *   - Una ventana etiquetada cuenta como DETECTADA si el detector dispara al
 *     menos una vez dentro de ella (recall).
 *   - Un episodio de disparos FUERA de toda ventana = FALSO POSITIVO.
 *   - Episodios = disparos consecutivos (huecos cortos) fusionados.
 *   Ningún detector ve el futuro ni las etiquetas: solo el pasado del flujo.
 */
const fs = require('fs');
const path = require('path');
const { RiverDetector } = require('./detector');

const DIR = process.argv[2], LAB = process.argv[3];
if (!DIR || !LAB) { console.error('uso: node river/nab-eval.js <dir_datos> <labels.json>'); process.exit(1); }
const labels = JSON.parse(fs.readFileSync(LAB, 'utf8'));
const toMs = s => Date.parse(s.trim().replace(' ', 'T') + 'Z');

// --- detector SIMPLE: z-score sobre ventana móvil fija ---
function baselineRun(values, W = 200, Z = 4) {
  const fires = [];
  for (let i = 0; i < values.length; i++) {
    if (i >= W) {
      let m = 0; for (let j = i - W; j < i; j++) m += values[j]; m /= W;
      let v = 0; for (let j = i - W; j < i; j++) v += (values[j] - m) ** 2; v = Math.sqrt(v / W);
      const z = v > 1e-9 ? (values[i] - m) / v : 0;
      if (Math.abs(z) >= Z) fires.push(i);
    }
  }
  return fires;
}

// --- RÍO ---
function riverRun(values) {
  const det = new RiverDetector({ halfLife: 100, warmup: 200, rippleZ: 4, cusumH: 6, shiftCooldown: 50 });
  const fires = [];
  for (let i = 0; i < values.length; i++) { const r = det.push(values[i]); if (r.ready && (r.ripple || r.shift)) fires.push(i); }
  return fires;
}

// fusiona índices en episodios (hueco > gap separa)
function episodes(idx, gap = 10) {
  const ep = []; let s = null, p = null;
  for (const i of idx) { if (s === null) { s = p = i; } else if (i - p <= gap) { p = i; } else { ep.push([s, p]); s = p = i; } }
  if (s !== null) ep.push([s, p]);
  return ep;
}

function score(fires, times, windows) {
  const ep = episodes(fires);
  const wins = windows.map(w => [toMs(w[0]), toMs(w[1])]);
  const hit = new Array(wins.length).fill(false);
  let fp = 0;
  for (const [a, b] of ep) {
    const ta = times[a], tb = times[b];
    let inWin = false;
    for (let k = 0; k < wins.length; k++) { if (tb >= wins[k][0] && ta <= wins[k][1]) { hit[k] = true; inWin = true; } }
    if (!inWin) fp++;
  }
  return { detected: hit.filter(Boolean).length, total: wins.length, fp, episodes: ep.length };
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.csv'));
let R = { det: 0, tot: 0, fp: 0 }, B = { det: 0, tot: 0, fp: 0 };
console.log('serie'.padEnd(42) + ' | ' + 'RÍO (det/win, FP)'.padEnd(20) + ' | SIMPLE (det/win, FP)');
console.log('-'.repeat(90));
for (const f of files) {
  const rows = fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').slice(1);
  const times = [], values = [];
  for (const r of rows) { const c = r.split(','); const t = toMs(c[0]); if (!isFinite(t)) continue; times.push(t); values.push(+c[1]); }
  const key = 'realKnownCause/' + f;
  const wins = labels[key] || [];
  if (!wins.length) { console.log(f.padEnd(42) + ' | (sin etiquetas en el índice)'); continue; }
  const sr = score(riverRun(values), times, wins);
  const sb = score(baselineRun(values), times, wins);
  R.det += sr.detected; R.tot += sr.total; R.fp += sr.fp;
  B.det += sb.detected; B.tot += sb.total; B.fp += sb.fp;
  console.log(f.slice(0, 41).padEnd(42) + ' | ' +
    `${sr.detected}/${sr.total}, FP ${sr.fp}`.padEnd(20) + ' | ' +
    `${sb.detected}/${sb.total}, FP ${sb.fp}`);
}
console.log('-'.repeat(90));
console.log('TOTAL'.padEnd(42) + ' | ' + `${R.det}/${R.tot} anom, ${R.fp} FP`.padEnd(20) + ' | ' + `${B.det}/${B.tot} anom, ${B.fp} FP`);
console.log('\nLectura: más anomalías detectadas es mejor; menos FP es mejor. Si el río no gana al simple, es un resultado honesto que hay que aceptar.');
