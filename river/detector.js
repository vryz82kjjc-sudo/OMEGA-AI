'use strict';
/*
 * RÍO — detector de flujo.
 *
 * Idea (metáfora del usuario): un río fluye hacia el mar. Mantiene un caudal
 * normal. Cuando cae una piedra, deja una ONDA que no es normal: ahí sabemos,
 * al momento, que pasó algo. No necesitamos conocer la piedra de antemano;
 * solo conocer el flujo normal y notar cuando se rompe.
 *
 * Distinguimos dos cosas que los sistemas pobres mezclan:
 *   1) LA ONDA  -> un pico transitorio (una piedra que cae y se va).
 *                  Se detecta con un z-score robusto sobre una media móvil.
 *   2) EL CAUCE -> un desplazamiento sostenido del nivel (el río se desvía
 *                  despacio: fuga lenta, ataque de bajo perfil). Se detecta
 *                  con CUSUM, que acumula pequeñas desviaciones en una
 *                  dirección hasta que el total deja de ser casualidad.
 *
 * Todo es en streaming: cada muestra actualiza el estado en O(1). No guarda
 * histórico, no espera a nadie. "Al momento".
 */

/**
 * Estima de forma robusta y en línea el centro y la dispersión del flujo.
 * - Centro: media exponencial (EWMA). Pondera lo reciente, olvida lo viejo.
 * - Dispersión: desviación absoluta media exponencial (robusta a picos; un
 *   solo valor enorme no hincha la escala como haría la varianza clásica).
 */
class FlowBaseline {
  /**
   * @param {object} o
   * @param {number} o.halfLife  Nº de muestras para que un peso caiga a la mitad.
   *                              Río "rápido" = memoria corta; "lento" = larga.
   * @param {number} o.warmup    Muestras mínimas antes de emitir juicios.
   */
  constructor({ halfLife = 50, warmup = 30 } = {}) {
    if (!(halfLife > 0)) throw new Error('halfLife debe ser > 0');
    this.alpha = 1 - Math.pow(0.5, 1 / halfLife); // factor de olvido
    this.warmup = warmup;
    this.n = 0;
    this.mean = 0;   // caudal normal estimado
    this.dev = 0;    // dispersión normal estimada (escala de la onda)
  }

  /** Incorpora una muestra y devuelve el estado anterior (para puntuar sin fuga). */
  observe(x) {
    const prevMean = this.mean;
    const prevDev = this.dev;
    if (this.n === 0) {
      this.mean = x;
      this.dev = 0;
    } else {
      const a = this.alpha;
      this.mean = a * x + (1 - a) * this.mean;
      const absResid = Math.abs(x - prevMean);
      this.dev = a * absResid + (1 - a) * this.dev;
    }
    this.n++;
    return { prevMean, prevDev };
  }

  get ready() { return this.n >= this.warmup; }
}

/**
 * CUSUM de dos caras: detecta un desplazamiento SOSTENIDO del nivel.
 * Acumula cuánto se aleja el flujo de su centro en cada dirección, restando
 * un colchón (drift) para no disparar con el ruido normal. Cuando el
 * acumulado supera un umbral, el cauce ha cambiado.
 */
class Cusum {
  /**
   * @param {number} drift      Colchón en nº de desviaciones (típico 0.5).
   * @param {number} threshold  Umbral de disparo en nº de desviaciones (típico 5).
   */
  constructor({ drift = 0.5, threshold = 5 } = {}) {
    this.k = drift;
    this.h = threshold;
    this.hi = 0; // acumulado hacia arriba
    this.lo = 0; // acumulado hacia abajo
  }

  /** @param {number} z  Desviación estandarizada de la muestra. */
  update(z) {
    this.hi = Math.max(0, this.hi + z - this.k);
    this.lo = Math.max(0, this.lo - z - this.k);
    const level = Math.max(this.hi, this.lo);
    const shifted = level > this.h;
    const direction = this.hi >= this.lo ? 'subida' : 'bajada';
    if (shifted) { this.hi = 0; this.lo = 0; } // reinicia tras avisar del nuevo cauce
    return { shifted, level, direction };
  }
}

/**
 * EL RÍO. Une base de flujo + onda + cauce sobre un único canal de datos.
 */
class RiverDetector {
  /**
   * @param {object} o
   * @param {number} o.halfLife   Memoria del flujo (muestras).
   * @param {number} o.warmup     Muestras para aprender antes de juzgar.
   * @param {number} o.rippleZ    A cuántas desviaciones una muestra es "onda".
   * @param {number} o.cusumDrift Colchón del CUSUM.
   * @param {number} o.cusumH     Umbral del CUSUM.
   */
  constructor(o = {}) {
    const { halfLife = 50, warmup = 30, rippleZ = 4, cusumDrift = 0.5, cusumH = 5 } = o;
    this.baseline = new FlowBaseline({ halfLife, warmup });
    this.cusum = new Cusum({ drift: cusumDrift, threshold: cusumH });
    this.rippleZ = rippleZ;
    this.t = 0;
  }

  /**
   * Procesa una muestra del río. Devuelve el veredicto AL MOMENTO.
   * @param {number} x  Valor observado (caudal, nº de peticiones, bytes, latencia...).
   * @returns {{
   *   t:number, value:number, mean:number, dev:number, z:number,
   *   ready:boolean, ripple:boolean, shift:boolean, shiftDir:?string,
   *   cusum:number, severity:number
   * }}
   */
  push(x) {
    this.t++;
    const { prevMean, prevDev } = this.baseline.observe(x);
    // Escala mínima para no dividir por ~0 en flujos muy planos.
    const scale = Math.max(prevDev, 1e-9);
    // Factor 1.2533 ~= sqrt(pi/2): convierte desv. absoluta media en algo
    // comparable a una desviación típica bajo ruido gaussiano.
    const z = this.baseline.n > 1 ? (x - prevMean) / (scale * 1.2533) : 0;

    const ready = this.baseline.ready;
    let ripple = false, shift = false, shiftDir = null, cusumLevel = 0;

    if (ready) {
      ripple = Math.abs(z) >= this.rippleZ;
      // Al CUSUM (detector de CAUCE) le pasamos el z SATURADO: una piedra
      // puntual enorme no debe contar como desvío sostenido. El cauce solo
      // cambia si MUCHAS muestras moderadas empujan en la misma dirección.
      const zSat = Math.max(-this.rippleZ, Math.min(this.rippleZ, z));
      const c = this.cusum.update(zSat);
      shift = c.shifted;
      shiftDir = c.direction;
      cusumLevel = c.level;
    }

    // Severidad 0..1: cuán anómala es esta muestra ahora mismo.
    const severity = ready
      ? Math.min(1, Math.max(Math.abs(z) / (this.rippleZ * 1.5), cusumLevel / (this.cusum.h * 1.5)))
      : 0;

    return {
      t: this.t, value: x, mean: this.baseline.mean, dev: this.baseline.dev,
      z, ready, ripple, shift, shiftDir, cusum: cusumLevel, severity
    };
  }
}

module.exports = { RiverDetector, FlowBaseline, Cusum };
