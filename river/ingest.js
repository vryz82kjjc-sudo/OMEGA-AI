'use strict';
/*
 * INGESTOR CIEGO. Lee un log de servidor web real, lo agrupa por minuto en
 * canales y lo pasa por el CAMPO DE RÍOS. No sabe dónde están los ataques:
 * los descubre solo. Si se le da la verdad oculta, compara al final.
 *
 *   node river/ingest.js <access.log> [verdad.json]
 *
 * Canales derivados del log:
 *   req_min    peticiones por minuto
 *   auth_fail  respuestas 401/403 por minuto (fuerza bruta)
 *   not_found  respuestas 404 por minuto (escaneo)
 *   bytes_mb   megabytes servidos por minuto (exfiltración)
 */
const fs = require('fs');
const { RiverField } = require('./field');

const LOG = process.argv[2];
const TRUTH = process.argv[3] || null;
if (!LOG) { console.error('uso: node river/ingest.js <access.log> [verdad.json]'); process.exit(1); }

// Parse de una línea de log Combined. Extrae minuto, estado y bytes.
const RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) [^"]*" (\d{3}) (\d+|-)/;
const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function parseTs(s) { // 24/Nov/2026:02:00:03 +0000
  const m = s.match(/(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]);
}

// Agrupar por minuto
const buckets = new Map(); // minuteIndex -> {req, auth, nf, bytes}
let t0 = null;
const lines = fs.readFileSync(LOG, 'utf8').split('\n');
for (const ln of lines) {
  const m = ln.match(RE); if (!m) continue;
  const ts = parseTs(m[2]); if (ts == null) continue;
  const status = +m[4], bytes = m[5] === '-' ? 0 : +m[5];
  if (t0 == null) t0 = ts;
  const mi = Math.floor((ts - t0) / 60000);
  let b = buckets.get(mi); if (!b) { b = { req: 0, auth: 0, nf: 0, bytes: 0 }; buckets.set(mi, b); }
  b.req++;
  if (status === 401 || status === 403) b.auth++;
  if (status === 404) b.nf++;
  b.bytes += bytes;
}

// Campo de ríos: 4 canales. Memoria/umbral adaptados a datos por-minuto.
const field = new RiverField(
  [
    { name: 'req_min',   opts: { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5 } },
    { name: 'auth_fail', opts: { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5 } },
    { name: 'not_found', opts: { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5 } },
    { name: 'bytes_mb',  opts: { halfLife: 20, warmup: 30, rippleZ: 4, cusumH: 5 } },
  ],
  { corrWindow: 3, corrMin: 2 }
);

const detections = [];
const maxMin = Math.max(...buckets.keys());
for (let mi = 0; mi <= maxMin; mi++) {
  const b = buckets.get(mi) || { req: 0, auth: 0, nf: 0, bytes: 0 };
  const r = field.push({ req_min: b.req, auth_fail: b.auth, not_found: b.nf, bytes_mb: b.bytes / 1e6 });
  const hot = Object.entries(r.channels).filter(([, v]) => v && (v.ripple || v.shift))
    .map(([k, v]) => k + (v.shift ? '(cauce)' : '(onda)'));
  if (hot.length) detections.push({ min: mi, hot, correlated: r.correlated, culprits: r.culprits });
}

console.log('=== LO QUE EL DETECTOR CIEGO ENCONTRÓ ===');
for (const d of detections) {
  console.log(`min ${String(d.min).padStart(3)}  ${d.hot.join(', ')}` + (d.correlated ? `   >>> CORRELACIONADO (${d.culprits.join('+')})` : ''));
}
console.log(`\n${detections.length} minuto(s) con anomalía.`);

if (TRUTH && fs.existsSync(TRUTH)) {
  const truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
  console.log('\n=== CONTRASTE CON LA VERDAD OCULTA ===');
  for (const t of truth) {
    // ¿detectó el canal correcto dentro de +-6 min del inicio del ataque?
    const hit = detections.find(d => Math.abs(d.min - t.min) <= 6 && d.hot.some(h => h.startsWith(t.canal)));
    console.log(`${t.type.padEnd(14)} (canal ${t.canal}, empieza min ${t.min}): ` +
      (hit ? `DETECTADO en min ${hit.min}  (latencia ${hit.min - t.min} min)` : 'NO detectado'));
  }
}
