'use strict';
/*
 * Genera un LOG de servidor web realista (formato Combined) con SIETE ataques
 * reales escondidos, modelados por su HUELLA en la telemetría (estilo MITRE
 * ATT&CK). No es malware: es cómo se VE cada ataque en los registros, que es
 * lo que un defensor necesita para detectarlo. El detector (ingest.js) es ciego.
 *
 *   node river/gen-log.js <salida.log> [verdad.json]
 *
 * Ataques (inicio → huella):
 *   1) DDoS volumétrico      m35  -> req_min e IPs únicas explotan
 *   2) Fuerza bruta (1 IP)   m55  -> auth_fail (onda)
 *   3) Credential stuffing   m80  -> auth_fail subiendo + IPs únicas (cauce, distribuido)
 *   4) Escaneo de vulns      m110 -> not_found subiendo (cauce)
 *   5) Sondeo de exploits    m140 -> server_err 5xx (onda)
 *   6) Exfiltración          m155 -> bytes_mb (onda)
 *   7) Troyano / beacon C2   m165 -> low-and-slow, 2 req/min a un host raro (SIGILOSO)
 */
const fs = require('fs');

const OUT = process.argv[2] || 'access.log';
const TRUTH = process.argv[3] || null;
const MIN = 210;
const START = new Date('2026-11-24T02:00:00Z').getTime();
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let seed = 20261124 >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = a => a[ri(0, a.length - 1)];

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari/604.1'
];
const BOTUA = 'python-requests/2.31';
const PATHS = ['/', '/index.html', '/products', '/about', '/api/items', '/api/user', '/static/app.js', '/static/style.css', '/img/logo.png', '/cart'];
const SCAN_PATHS = ['/admin', '/wp-login.php', '/.env', '/phpmyadmin', '/config.php', '/backup.zip', '/.git/config', '/api/v1/secret', '/server-status'];

const ip = () => `${ri(10,220)}.${ri(0,255)}.${ri(0,255)}.${ri(1,254)}`;
const ts = (ms) => { const d = new Date(ms); const p = n => String(n).padStart(2,'0');
  return `${p(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };
const line = (cip, ms, method, path, status, bytes, ua) =>
  `${cip} - - [${ts(ms)}] "${method} ${path} HTTP/1.1" ${status} ${bytes} "-" "${ua}"`;

const out = [];
const truth = [];
const BF_IP = '203.0.113.77';   // fuerza bruta
const SCAN_IP = '203.0.113.99'; // escaneo de vulns
const EXFIL_IP = '198.51.100.23';
const C2_HOST = '10.0.0.45';    // host interno comprometido (troyano)

function markTruth(min, type, canal) { truth.push({ min, type, canal: [].concat(canal) }); }

for (let m = 0; m < MIN; m++) {
  const minMs = START + m * 60000;
  const lines = [];

  // --- tráfico normal: ritmo diurno + ruido ---
  const rate = Math.round(26 + 12 * Math.sin(m / 28) + (rnd() - 0.5) * 8);
  for (let k = 0; k < Math.max(5, rate); k++) {
    const ms = minMs + ri(0, 59999);
    const r = rnd();
    let path = pick(PATHS), status = 200, bytes = ri(400, 6000), method = 'GET';
    if (r < 0.035) { status = 404; bytes = ri(200, 500); path = '/' + pick(['old','promo2019','favicon2.ico']); }
    else if (r < 0.05) { method = 'POST'; path = '/login'; status = rnd() < 0.3 ? 401 : 200; bytes = ri(300, 900); }
    else if (r < 0.06) { status = 500; bytes = ri(200, 600); } // 5xx normales (raros)
    lines.push({ ms, text: line(ip(), ms, method, path, status, bytes, pick(UAS)) });
  }

  // --- 1) DDoS volumétrico (m35-39) ---
  if (m >= 35 && m <= 39) {
    const flood = ri(180, 240);
    for (let k = 0; k < flood; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(ip(), ms, 'GET', '/', rnd() < 0.4 ? 503 : 200, ri(200, 800), BOTUA) }); }
    if (m === 35) markTruth(m, 'ddos', ['req_min', 'unique_ips']);
  }

  // --- 2) Fuerza bruta de credenciales, 1 IP (m55-59) ---
  if (m >= 55 && m <= 59) {
    const hits = ri(70, 95);
    for (let k = 0; k < hits; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(BF_IP, ms, 'POST', '/login', 401, ri(280, 340), UAS[0]) }); }
    if (m === 55) markTruth(m, 'fuerza_bruta', 'auth_fail');
  }

  // --- 3) Credential stuffing DISTRIBUIDO, muchas IPs, creciente (m80-95) ---
  if (m >= 80 && m <= 95) {
    const intensidad = Math.round(3 + (m - 80) * 1.1);
    for (let k = 0; k < intensidad; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(ip(), ms, 'POST', '/login', 401, ri(280, 340), pick(UAS)) }); } // IP distinta cada vez
    if (m === 80) markTruth(m, 'cred_stuffing', ['auth_fail', 'unique_ips']);
  }

  // --- 4) Escaneo de vulnerabilidades, creciente (m110-130) ---
  if (m >= 110 && m <= 130) {
    const intensidad = Math.round(3 + (m - 110) * 0.9);
    for (let k = 0; k < intensidad; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(SCAN_IP, ms, 'GET', pick(SCAN_PATHS), 404, ri(150, 400), BOTUA) }); }
    if (m === 110) markTruth(m, 'escaneo_vulns', 'not_found');
  }

  // --- 5) Sondeo de exploits / inyección: provoca 5xx (m140-144) ---
  if (m >= 140 && m <= 144) {
    const hits = ri(20, 30);
    for (let k = 0; k < hits; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(SCAN_IP, ms, 'GET', "/api/items?id=1'%20OR%201=1--", 500, ri(300, 900), BOTUA) }); }
    if (m === 140) markTruth(m, 'sondeo_exploits', 'server_err');
  }

  // --- 6) Exfiltración de datos (m155-159): descargas enormes ---
  if (m >= 155 && m <= 159) {
    const grabs = ri(3, 6);
    for (let k = 0; k < grabs; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(EXFIL_IP, ms, 'GET', '/api/export?all=1', 200, ri(8_000_000, 45_000_000), UAS[1]) }); }
    if (m === 155) markTruth(m, 'exfiltracion', 'bytes_mb');
  }

  // --- 7) Troyano / beacon C2 (m165-209): LOW-AND-SLOW pero PERIÓDICO.
  // Llama a casa cada ~30 s (segundos :10 y :40) con poco jitter. Invisible
  // para el volumen; detectable por la REGULARIDAD de sus intervalos. ---
  if (m >= 165) {
    for (const base of [10, 40]) { const ms = minMs + (base + (rnd() * 4 - 2)) * 1000 | 0;
      lines.push({ ms, text: line(C2_HOST, ms, 'POST', '/assets/p.gif', 200, ri(120, 260), 'Go-http-client/1.1') }); }
    if (m === 165) markTruth(m, 'troyano_c2_SIGILOSO', 'beacon');
  }

  lines.sort((a, b) => a.ms - b.ms);
  for (const l of lines) out.push(l.text);
}

fs.writeFileSync(OUT, out.join('\n') + '\n');
console.log(`Log generado: ${OUT}  (${out.length} líneas, ${MIN} minutos)`);
if (TRUTH) { fs.writeFileSync(TRUTH, JSON.stringify(truth, null, 2)); }
console.log('Ataques escondidos:', truth.map(t => `${t.type}@m${t.min}`).join(', '));
