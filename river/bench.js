'use strict';
/*
 * BANCO DE MEDICIÓN. Cuantifica la tasa de falsas alarmas y la detección sobre
 * muchas corridas, alimentando el campo de ríos directamente con métricas por
 * minuto (más rápido y limpio que generar/parsear logs miles de veces).
 *
 *   node river/bench.js
 *
 * Distingue, como un SOC real:
 *   SEÑAL  = cualquier onda/cauce en un minuto (ruido de bajo nivel).
 *   ALERTA = algo CORRELACIONADO, o una anomalía que PERSISTE >=2 minutos
 *            seguidos en el mismo canal. Es lo que de verdad despierta a alguien.
 */
const { RiverField } = require('./field');
const { makeRng, gauss } = require('./simulate');

const CH = ['req_min', 'auth_fail', 'not_found', 'server_err', 'unique_ips', 'bytes_mb'];
const cnt = { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5, poisson: true };
const bytesOpt = { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5 };
const mkField = () => new RiverField(
  CH.map(n => ({ name: n, opts: n === 'bytes_mb' ? bytesOpt : cnt })),
  { corrWindow: 3, corrMin: 2 }
);

// Minuto NORMAL (sin ataque): conteos con ruido tipo Poisson + vaivén diurno.
function normalMinute(rng, m) {
  const req = Math.max(5, Math.round(26 + 12 * Math.sin(m / 28) + gauss(rng) * 5));
  return {
    req_min: req,
    auth_fail: Math.max(0, Math.round(0.6 + gauss(rng) * 0.9)),
    not_found: Math.max(0, Math.round(1.0 + gauss(rng) * 1.2)),
    server_err: Math.max(0, Math.round(0.6 + gauss(rng) * 0.9)),
    unique_ips: Math.max(3, Math.round(req * 0.8 + gauss(rng) * 3)),
    bytes_mb: Math.max(0.1, 2 + gauss(rng) * 0.6),
  };
}

// Convierte la salida por minuto en SEÑAL y ALERTA.
function classify(field, minutes) {
  const run = {}; // canal -> minutos consecutivos anómalos
  let signalMins = 0, alertMins = 0;
  for (let m = 0; m < minutes.length; m++) {
    const r = field.push(minutes[m]);
    const hot = CH.filter(n => { const v = r.channels[n]; return v && (v.ripple || v.shift); });
    if (hot.length) signalMins++;
    let alert = r.correlated;
    for (const n of CH) {
      const v = r.channels[n];
      if (v && (v.ripple || v.shift)) { run[n] = (run[n] || 0) + 1; if (run[n] >= 2) alert = true; }
      else run[n] = 0;
    }
    if (alert) alertMins++;
  }
  return { signalMins, alertMins };
}

// ---------- 1) FALSAS ALARMAS sobre tráfico 100% normal ----------
const SEEDS = 100, MINUTES = 400;
let sigFP = 0, alertFP = 0, totalMin = 0;
for (let s = 1; s <= SEEDS; s++) {
  const rng = makeRng(1000 + s);
  const mins = []; for (let m = 0; m < MINUTES; m++) mins.push(normalMinute(rng, m));
  const { signalMins, alertMins } = classify(mkField(), mins);
  sigFP += signalMins; alertFP += alertMins; totalMin += MINUTES;
}
console.log('=== FALSAS ALARMAS sobre tráfico NORMAL ===');
console.log(`corridas: ${SEEDS}  ·  minutos totales: ${totalMin}`);
console.log(`SEÑALES falsas: ${sigFP}  (${(100*sigFP/totalMin).toFixed(3)}% de minutos)  ~1 cada ${Math.round(totalMin/Math.max(sigFP,1))} min`);
console.log(`ALERTAS falsas: ${alertFP}  (${(100*alertFP/totalMin).toFixed(3)}% de minutos)  ~1 cada ${Math.round(totalMin/Math.max(alertFP,1))} min`);

// ---------- 2) DETECCIÓN: un ataque de fuerza bruta inyectado ----------
let detected = 0, lat = [];
for (let s = 1; s <= SEEDS; s++) {
  const rng = makeRng(5000 + s);
  const mins = [];
  for (let m = 0; m < 200; m++) {
    const x = normalMinute(rng, m);
    if (m >= 120 && m <= 125) { x.auth_fail += 40; x.req_min += 40; } // fuerza bruta
    mins.push(x);
  }
  const field = mkField(); let at = null;
  for (let m = 0; m < mins.length; m++) {
    const r = field.push(mins[m]);
    if (m >= 120 && at === null && (r.correlated || (r.channels.auth_fail && (r.channels.auth_fail.ripple || r.channels.auth_fail.shift)))) at = m;
  }
  if (at !== null) { detected++; lat.push(at - 120); }
}
const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
console.log('\n=== DETECCIÓN (fuerza bruta inyectada en min 120) ===');
console.log(`detectado: ${detected}/${SEEDS}  ·  latencia media: ${avg(lat)} min`);
