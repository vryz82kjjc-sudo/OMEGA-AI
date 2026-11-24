'use strict';
/*
 * INGESTOR CIEGO con DEFENSA POR CAPAS.
 *   node river/ingest.js <access.log> [verdad.json]
 *
 * Capa A — CAMPO DE RÍOS (volumen): detecta ataques que mueven cantidades
 *   (DDoS, fuerza bruta, credential stuffing, escaneo, exploits, exfiltración).
 *   Canales por minuto, con suelo de Poisson en los de conteo:
 *     req_min · auth_fail(401/403) · not_found(404) · server_err(5xx) ·
 *     bytes_mb · unique_ips
 *
 * Capa B — PERIODICIDAD: detecta el beacon de un troyano (low-and-slow). El
 *   volumen no lo ve; su firma es la REGULARIDAD de los intervalos de una fuente.
 */
const fs = require('fs');
const { RiverField } = require('./field');

const LOG = process.argv[2];
const TRUTH = process.argv[3] || null;
if (!LOG) { console.error('uso: node river/ingest.js <access.log> [verdad.json]'); process.exit(1); }

const RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*) HTTP[^"]*" (\d{3}) (\d+|-)/;
const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function parseTs(s) {
  const m = s.match(/(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) : null;
}

const buckets = new Map();  // minuto -> {req,auth,nf,err,bytes,ips:Set}
const bySrc = new Map();     // ip -> {path -> [timestamps]}
let t0 = null;
for (const ln of fs.readFileSync(LOG, 'utf8').split('\n')) {
  const m = ln.match(RE); if (!m) continue;
  const srcIp = m[1], ts = parseTs(m[2]); if (ts == null) continue;
  const path = m[4], status = +m[5], bytes = m[6] === '-' ? 0 : +m[6];
  if (t0 == null) t0 = ts;
  const mi = Math.floor((ts - t0) / 60000);
  let b = buckets.get(mi); if (!b) { b = { req: 0, auth: 0, nf: 0, err: 0, bytes: 0, ips: new Set() }; buckets.set(mi, b); }
  b.req++; b.ips.add(srcIp);
  if (status === 401 || status === 403) b.auth++;
  if (status === 404) b.nf++;
  if (status >= 500) b.err++;
  b.bytes += bytes;
  // para periodicidad: timestamps por (ip|path)
  const key = srcIp + '|' + path;
  let arr = bySrc.get(key); if (!arr) { arr = []; bySrc.set(key, arr); } arr.push(ts);
}

// ---------- Capa A: campo de ríos ----------
const cnt = { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5, poisson: true };
const field = new RiverField([
  { name: 'req_min',   opts: cnt },
  { name: 'auth_fail', opts: cnt },
  { name: 'not_found', opts: cnt },
  { name: 'server_err',opts: cnt },
  { name: 'unique_ips',opts: cnt },
  { name: 'bytes_mb',  opts: { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5 } }, // no es conteo
], { corrWindow: 3, corrMin: 2 });

const detections = [];
const maxMin = Math.max(...buckets.keys());
for (let mi = 0; mi <= maxMin; mi++) {
  const b = buckets.get(mi) || { req: 0, auth: 0, nf: 0, err: 0, bytes: 0, ips: new Set() };
  const r = field.push({ req_min: b.req, auth_fail: b.auth, not_found: b.nf, server_err: b.err, unique_ips: b.ips.size, bytes_mb: b.bytes / 1e6 });
  const hot = Object.entries(r.channels).filter(([, v]) => v && (v.ripple || v.shift)).map(([k]) => k);
  if (hot.length) detections.push({ min: mi, hot, correlated: r.correlated, culprits: r.culprits });
}

console.log('=== CAPA A (ríos de volumen) — anomalías por minuto ===');
for (const d of detections) console.log(`m${String(d.min).padStart(3)}  ${d.hot.join(', ')}` + (d.correlated ? `   >>> CORRELACIONADO (${d.culprits.join('+')})` : ''));

// ---------- Capa B: periodicidad (beacon de troyano) ----------
// Una fuente con MUCHAS peticiones a un MISMO destino, espaciadas de forma muy
// REGULAR, es sospechosa de beacon C2. Medimos el coeficiente de variación
// (desv/media) de los intervalos: muy bajo = demasiado regular para un humano.
function beaconScan() {
  const hits = [];
  for (const [key, times] of bySrc) {
    if (times.length < 15) continue;
    times.sort((a, b) => a - b);
    const gaps = []; for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
    const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    if (mean < 5 || mean > 300) continue; // intervalos propios de beacon (segundos a pocos min)
    const varr = gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length;
    const cv = Math.sqrt(varr) / mean; // coeficiente de variación
    if (cv < 0.25) { const [ip, path] = key.split('|'); hits.push({ ip, path, n: times.length, intervalo: mean.toFixed(1), cv: cv.toFixed(3) }); }
  }
  return hits;
}
const beacons = beaconScan();
console.log('\n=== CAPA B (periodicidad) — posibles beacons C2 ===');
if (beacons.length) for (const b of beacons) console.log(`SOSPECHOSO: ${b.ip} -> ${b.path}  (${b.n} llamadas, cada ~${b.intervalo}s, regularidad cv=${b.cv})`);
else console.log('ninguno');

// ---------- Contraste con la verdad ----------
if (TRUTH && fs.existsSync(TRUTH)) {
  const truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
  console.log('\n=== CONTRASTE CON LA VERDAD OCULTA ===');
  for (const t of truth) {
    const canales = [].concat(t.canal);
    let verdict;
    if (canales.includes('beacon')) {
      verdict = beacons.length ? `DETECTADO por periodicidad (${beacons[0].ip})` : 'NO detectado';
    } else {
      const hit = detections.find(d => Math.abs(d.min - t.min) <= 6 && d.hot.some(h => canales.includes(h)));
      verdict = hit ? `DETECTADO en m${hit.min} (latencia ${hit.min - t.min})` : 'NO detectado';
    }
    console.log(`${t.type.padEnd(20)} (${canales.join('/')}, m${t.min}): ${verdict}`);
  }
}
