'use strict';
/*
 * Río sintético para probar el detector sin infraestructura real.
 * Genera un caudal "normal" (base + oleaje suave + ruido) y permite
 * inyectar eventos: PIEDRA (pico puntual) y DESVÍO (cambio de cauce sostenido).
 */

/** Generador pseudoaleatorio determinista (para resultados repetibles). */
function makeRng(seed = 314159) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Caja de Muller-ish rápida: ruido ~ normal(0,1) a partir de uniforme. */
function gauss(rng) {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rng();
  return (s - 3) / Math.sqrt(0.5); // media 0, desv ~1
}

/**
 * Crea un río.
 * @param {object} o
 * @param {number} o.base   Caudal medio normal.
 * @param {number} o.noise  Amplitud del ruido normal (la "dispersión" sana).
 * @param {number} o.seed   Semilla.
 */
function makeRiver({ base = 100, noise = 4, seed = 314159 } = {}) {
  const rng = makeRng(seed);
  let t = 0;
  let courseOffset = 0; // desvío sostenido acumulado (cambio de cauce)
  return {
    /** Avanza un instante y devuelve el caudal observado. */
    tick() {
      t++;
      const swell = 6 * Math.sin(t / 40); // oleaje lento y normal del río
      return base + courseOffset + swell + gauss(rng) * noise;
    },
    /** Desvía el cauce: suma un offset permanente (ataque lento/fuga). */
    divert(delta) { courseOffset += delta; },
    get time() { return t; }
  };
}

module.exports = { makeRiver, makeRng, gauss };
