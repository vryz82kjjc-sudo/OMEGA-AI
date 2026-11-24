'use strict';
/*
 * LA LEY DEL √n — demostración empírica de la "fuerza matemática" de cada
 * mecanismo, en condiciones controladas (ruido gaussiano σ=1, desvío δ).
 *
 *   node river/sqrt-n.js [salida.json]
 *
 * Compara:
 *   MANO  (z puntual): dispara si |x| >= 4. Sin memoria.
 *   DINAMITA (CUSUM): acumula; dispara si el acumulado supera h.
 *
 * Demuestra: el umbral puntual necesita un golpe grande (δ~4σ) PASE LO QUE
 * PASE; el CUSUM detecta desvíos diminutos si les da tiempo, y el desvío
 * mínimo detectable cae como 1/√n.
 */
const RNG = (s => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; })(12345);
const gauss = () => { let x = 0; for (let i = 0; i < 12; i++) x += RNG(); return x - 6; }; // ~N(0,1)

// ¿detecta un CUSUM un desvío δ dentro de n muestras? (k=0.5, h=5)
function cusumDetect(delta, n, k = 0.5, h = 5) {
  let hi = 0;
  for (let i = 0; i < n; i++) { const x = delta + gauss(); hi = Math.max(0, hi + x - k); if (hi > h) return i + 1; }
  return null;
}
// ¿detecta el umbral puntual (|z|>=4) un desvío δ dentro de n muestras?
function pointDetect(delta, n, z = 4) {
  for (let i = 0; i < n; i++) { if (Math.abs(delta + gauss()) >= z) return i + 1; }
  return null;
}
function prob(fn, delta, n, trials = 400) { let hit = 0, lat = 0; for (let t = 0; t < trials; t++) { const d = fn(delta, n); if (d != null) { hit++; lat += d; } } return { p: hit / trials, lat: hit ? lat / hit : null }; }

console.log('=== 1) A igual tiempo (n=300), ¿quién detecta cada desvío δ? ===');
console.log('δ(σ)  | MANO (prob)      | DINAMITA (prob, latencia media)');
for (const d of [0.1, 0.2, 0.3, 0.5, 0.8, 1.5, 3]) {
  const m = prob(pointDetect, d, 300), c = prob(cusumDetect, d, 300);
  console.log(` ${d.toFixed(1).padStart(3)}  |  ${(m.p * 100).toFixed(0).padStart(3)}%           |  ${(c.p * 100).toFixed(0).padStart(3)}%   ${c.lat ? '(~' + c.lat.toFixed(0) + ' muestras)' : ''}`);
}

console.log('\n=== 2) LA LEY √n: desvío mínimo detectable (prob>=50%) según el tiempo n ===');
console.log('n     | δ_min DINAMITA | δ_min × √n  (debería ser ~constante)');
const rows = [];
for (const n of [25, 50, 100, 200, 400, 800]) {
  let dmin = null;
  for (let d = 2.0; d >= 0.02; d -= 0.02) { if (prob(cusumDetect, d, n, 300).p >= 0.5) dmin = d; else break; }
  const prod = dmin != null ? dmin * Math.sqrt(n) : null;
  rows.push({ n, dmin, prod });
  console.log(` ${String(n).padStart(4)} |     ${dmin != null ? dmin.toFixed(2) : ' - '}       |   ${prod != null ? prod.toFixed(2) : '-'}`);
}
console.log('\nSi la columna "δ_min × √n" es casi constante, confirma δ_min ∝ 1/√n:');
console.log('la DINAMITA gana fuerza con el tiempo; la MANO no (su δ_min ~4 siempre).');

if (process.argv[2]) require('fs').writeFileSync(process.argv[2], JSON.stringify({ law: rows }, null, 2));
