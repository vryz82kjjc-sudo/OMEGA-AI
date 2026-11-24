'use strict';
/*
 * CAMPO DE RÍOS — muchos ríos vigilados a la vez.
 *
 * Un solo río no defiende nada: un pico aislado suele ser ruido. La fuerza
 * está en mirar MUCHAS señales en paralelo (CPU, red, logins, latencia, por
 * IP...) y, sobre todo, en detectar cuándo VARIAS se mueven JUNTAS. Eso ya no
 * es casualidad: es un evento coordinado.
 *
 *   río suelto con una onda      -> ruido, se ignora
 *   varios ríos con onda a la vez -> ATAQUE / incidente correlacionado
 */
const { RiverDetector } = require('./detector');

class RiverField {
  /**
   * @param {Array<{name:string, opts?:object}>} channels  Canales a vigilar.
   * @param {object} o
   * @param {number} o.corrWindow  Ventana (muestras) para considerar coincidentes
   *                               dos anomalías de canales distintos.
   * @param {number} o.corrMin     Nº mínimo de canales anómalos a la vez para
   *                               declarar un evento correlacionado.
   */
  constructor(channels, { corrWindow = 5, corrMin = 2 } = {}) {
    this.rivers = new Map();
    for (const c of channels) this.rivers.set(c.name, new RiverDetector(c.opts || {}));
    this.corrWindow = corrWindow;
    this.corrMin = corrMin;
    this.lastHit = new Map(); // canal -> t de su última anomalía
    this.t = 0;
    this.lastCorrT = -Infinity; // para no repetir el aviso correlacionado
  }

  /**
   * Procesa una muestra en cada canal. `sample` es {canal: valor}. Los canales
   * ausentes en esta muestra simplemente no avanzan.
   * @returns {{t:number, channels:object, correlated:boolean, culprits:string[], worst:number}}
   */
  push(sample) {
    this.t++;
    const channels = {};
    const anomalousNow = [];

    for (const [name, det] of this.rivers) {
      if (!(name in sample)) { channels[name] = null; continue; }
      const r = det.push(Number(sample[name]));
      channels[name] = r;
      if (r.ready && (r.ripple || r.shift)) {
        this.lastHit.set(name, this.t);
      }
      if (r.ready && r.severity > 0.6) anomalousNow.push(name);
    }

    // Correlación: ¿cuántos canales han tenido anomalía dentro de la ventana?
    const recent = [];
    for (const [name, tHit] of this.lastHit) {
      if (this.t - tHit <= this.corrWindow) recent.push(name);
    }
    let correlated = false;
    let culprits = recent;
    if (recent.length >= this.corrMin && this.t - this.lastCorrT > this.corrWindow) {
      correlated = true;
      this.lastCorrT = this.t;
    }

    // Peor severidad del sistema ahora mismo (0..1).
    let worst = 0;
    for (const name in channels) {
      const r = channels[name];
      if (r && r.severity > worst) worst = r.severity;
    }

    return { t: this.t, channels, correlated, culprits, worst };
  }

  names() { return [...this.rivers.keys()]; }
}

module.exports = { RiverField };
