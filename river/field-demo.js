'use strict';
/*
 * Demuestra la correlación. Cinco ríos (señales de un sistema). Escenario:
 *   - t=150: onda SUELTA en 'latencia' (ruido normal, NO debe ser coordinado).
 *   - t=300: ATAQUE coordinado: cpu, red_in y logins suben a la vez.
 */
const { RiverField } = require('./field');
const { makeRng, gauss } = require('./simulate');

const CH = ['cpu', 'red_in', 'red_out', 'logins', 'latencia'];
const base = { cpu: 30, red_in: 500, red_out: 300, logins: 5, latencia: 40 };
const noise = { cpu: 3, red_in: 40, red_out: 25, logins: 1.2, latencia: 4 };

const field = new RiverField(CH.map(n => ({ name: n })), { corrWindow: 6, corrMin: 2 });
const rng = makeRng(2024);
const events = [];

for (let t = 1; t <= 400; t++) {
  const s = {};
  for (const n of CH) s[n] = base[n] + gauss(rng) * noise[n];

  if (t === 150) s.latencia += 45;                 // onda suelta (ruido)
  if (t >= 300 && t <= 320) {                       // ataque coordinado sostenido
    s.cpu += 25; s.red_in += 350; s.logins += 12;
  }

  const r = field.push(s);
  const hot = Object.entries(r.channels).filter(([, v]) => v && (v.ripple || v.shift)).map(([k]) => k);
  if (hot.length) events.push(`t=${t}  anomalía en: ${hot.join(', ')}` + (r.correlated ? `   >>> CORRELACIONADO (${r.culprits.join('+')})` : ''));
}

console.log('--- eventos ---');
for (const e of events) console.log(e);
const corr = events.filter(e => e.includes('CORRELACIONADO')).length;
console.log(`\nResumen: ${events.length} evento(s), ${corr} correlacionado(s).`);
console.log('Esperado: onda suelta en t~150 SIN correlación; ataque en t~300 CON correlación.');
