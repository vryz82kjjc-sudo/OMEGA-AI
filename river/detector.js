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
  constructor({ halfLife = 50, warmup = 30, huberZ = 4 } = {}) {
    if (!(halfLife > 0)) throw new Error('halfLife debe ser > 0');
    this.alpha = 1 - Math.pow(0.5, 1 / halfLife); // factor de olvido
    this.warmup = warmup;
    this.huberZ = huberZ; // más allá de esto, la muestra no arrastra la media
    this.n = 0;
    this.mean = 0;   // caudal normal estimado
    this.dev = 0;    // dispersión normal estimada (escala de la onda)
  }

  /** Incorpora una muestra y devuelve el estado anterior (para puntuar sin fuga). */
  observe(x) {
    const K = 1.2533;
    const prevMean = this.mean;
    const prevDev = this.dev;
    if (this.n === 0) {
      this.mean = x;
      this.dev = 0;
    } else {
      const a = this.alpha;
      // EWMA ROBUSTO (Huber): una piedra enorme NO debe arrastrar la media del
      // río. Actualizamos la media hacia un valor recortado a ±huberZ·escala,
      // así la base se mantiene estable durante el pico y no deja un "hueco"
      // que luego parezca anomalía (la cola de falsas alarmas tras un pico).
      let xUpd = x;
      if (prevDev > 0) {
        const lim = this.huberZ * prevDev * K;
        xUpd = Math.max(prevMean - lim, Math.min(prevMean + lim, x));
      }
      this.mean = a * xUpd + (1 - a) * this.mean;
      // La dispersión también es robusta: un residuo mayor que ~8 desviaciones
      // no enseña la escala más allá de ese tope.
      let absResid = Math.abs(x - prevMean);
      if (prevDev > 0) absResid = Math.min(absResid, 8 * prevDev);
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
    // Una sola base de flujo alimenta ambos detectores a partir del MISMO
    // residuo estandarizado. La base sigue el oleaje normal (lo elimina del
    // residuo), así que ni la onda ni el cauce se disparan con el vaivén sano.
    //  - ONDA  = |z| puntual grande.
    //  - CAUCE = CUSUM: muchos z moderados sostenidos en una dirección. El
    //    colchón (drift) se fija por encima del pequeño sesgo que el oleaje
    //    deja en el residuo, de modo que solo un desvío REAL acumula.
    const { halfLife = 15, warmup = 40, rippleZ = 4, cusumDrift = 1.0, cusumH = 5, shiftCooldown = 30, poisson = false } = o;
    this.baseline = new FlowBaseline({ halfLife, warmup, huberZ: rippleZ });
    this.cusum = new Cusum({ drift: cusumDrift, threshold: cusumH });
    this.rippleZ = rippleZ;
    // Para canales de CONTEO (logins, 404...): la dispersión no puede caer por
    // debajo del ruido de Poisson (~sqrt(media)). Evita que un 0->2 parezca
    // enorme cuando el canal normalmente está casi a cero.
    this.poisson = poisson;
    this.shiftCooldown = shiftCooldown; // muestras de silencio tras avisar de un cauce
    this.cooldownUntil = 0;
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
    const K = 1.2533; // sqrt(pi/2): desv. absoluta media -> desv. típica (ruido gaussiano)

    const { prevMean, prevDev } = this.baseline.observe(x);
    // Escala = dispersión aprendida, pero nunca por debajo del ruido de Poisson
    // en canales de conteo (suelo = sqrt(media)).
    const floor = this.poisson ? Math.sqrt(Math.max(prevMean, 1)) : 0;
    const scale = Math.max(prevDev * K, floor, 1e-9);
    const z = this.baseline.n > 1 ? (x - prevMean) / scale : 0;

    const ready = this.baseline.ready;
    let ripple = false, shift = false, shiftDir = null, cusumLevel = 0;

    if (ready) {
      ripple = Math.abs(z) >= this.rippleZ;
      // Al CUSUM le pasamos el z SATURADO: una piedra puntual no debe contar
      // como desvío sostenido. El cauce cambia solo si muchas muestras
      // moderadas empujan en la misma dirección.
      const zSat = Math.max(-this.rippleZ, Math.min(this.rippleZ, z));
      const c = this.cusum.update(zSat);
      cusumLevel = c.level;
      // Periodo refractario: un desvío sostenido es UN evento, no muchos. Tras
      // avisar, callamos mientras la base absorbe el nuevo nivel del río.
      if (c.shifted && this.t >= this.cooldownUntil) {
        shift = true; shiftDir = c.direction;
        this.cooldownUntil = this.t + this.shiftCooldown;
      }
    }

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
