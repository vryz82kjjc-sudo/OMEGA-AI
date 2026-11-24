'use strict';
/*
 * Demostración: el río fluye normal; en t=120 cae una PIEDRA (onda puntual);
 * en t=250 se DESVÍA el cauce despacio (shift sostenido). El detector debe
 * cantar la onda al instante y, poco después, avisar del cambio de cauce.
 */
const { RiverDetector } = require('./detector');
const { makeRiver } = require('./simulate');

const river = makeRiver({ base: 100, noise: 4, seed: 314159 });
const det = new RiverDetector(); // valores por defecto (base rápida + CUSUM calibrado)

const events = [];
for (let i = 1; i <= 400; i++) {
  let x = river.tick();
  if (i === 120) x += 45;            // PIEDRA: pico transitorio en esta muestra
  if (i === 250) river.divert(14);   // DESVÍO: el cauce sube y se queda arriba

  const r = det.push(x);
  if (r.ripple) events.push(`t=${r.t}  ONDA detectada  (z=${r.z.toFixed(1)}, valor=${x.toFixed(1)}, caudal normal≈${r.mean.toFixed(1)})`);
  if (r.shift) events.push(`t=${r.t}  CAUCE cambiado   (dirección=${r.shiftDir}, cusum=${r.cusum.toFixed(1)})`);
}

console.log('--- Eventos que el río detectó AL MOMENTO ---');
for (const e of events) console.log(e);
console.log('\nResumen:', events.length, 'evento(s). (Esperado: 1 onda ~t120, 1 cambio de cauce poco después de t250)');
