'use strict';
/*
 * FIRMA ESPECTRAL — "la ecuación de cada onda".
 *
 * Por el teorema de Fourier, cualquier trozo de señal es una suma de ondas
 * simples, cada una con su frecuencia y su amplitud. Aquí calculamos esa
 * descomposición (FFT) sobre una ventana y extraemos la FORMA de la onda:
 *
 *   energía      cuánta onda hay (más allá del nivel)
 *   centroide    dónde está el "centro" de frecuencias (bajo=lento, alto=rápido)
 *   entropía     ¿la energía está en UNA frecuencia (periódico, beacon) o
 *                repartida (ruido)?  baja=periódico, alta=ruido
 *   pico         fracción de energía en la frecuencia dominante (periodicidad)
 *   baja_freq    energía en las frecuencias más lentas (tendencia / escalón)
 *
 * Estas características dicen QUÉ forma tiene la anomalía, no solo si es rara.
 */

// FFT radix-2 in situ (longitud potencia de 2). Modifica re, im.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const bi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + (len >> 1)] = ar - br; im[i + k + (len >> 1)] = ai - bi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// ventana de Hann (reduce fugas espectrales)
function hann(N) { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); return w; }

/**
 * Características espectrales de una ventana de valores (longitud potencia de 2).
 * Se le quita la media (analizamos la FORMA, no el nivel) y se aplica Hann.
 * @returns {{energy, centroid, entropy, peak, lowFrac}}
 */
function spectralFeatures(win, w) {
  const N = win.length;
  let mean = 0; for (const v of win) mean += v; mean /= N;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (win[i] - mean) * w[i];
  fft(re, im);
  const half = N >> 1;
  let total = 0, cen = 0, peak = 0, low = 0;
  const P = new Float64Array(half);
  for (let k = 1; k < half; k++) { const p = re[k] * re[k] + im[k] * im[k]; P[k] = p; total += p; cen += k * p; if (p > peak) peak = p; if (k <= 4) low += p; }
  if (total < 1e-12) return { energy: 0, centroid: 0, entropy: 1, peak: 0, lowFrac: 0 };
  let ent = 0; for (let k = 1; k < half; k++) { const pr = P[k] / total; if (pr > 0) ent -= pr * Math.log(pr); }
  ent /= Math.log(half - 1); // 0=una frecuencia, 1=plano
  return {
    energy: Math.sqrt(total / N),       // amplitud de onda
    centroid: cen / total / half,        // 0..1
    entropy: ent,                        // 0..1
    peak: peak / total,                  // 0..1 (periodicidad)
    lowFrac: low / total,                // 0..1 (tendencia)
  };
}

module.exports = { fft, hann, spectralFeatures };
