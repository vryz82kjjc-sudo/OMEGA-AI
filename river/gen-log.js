'use strict';
/*
 * Genera un LOG de servidor web realista (formato Combined, como nginx/Apache)
 * con TRES ataques escondidos dentro, a horas concretas. El detector (ingest.js)
 * NO sabe dónde están: los descubre solo. Aquí está la "verdad" para comparar
 * después.
 *
 *   node river/gen-log.js <salida.log> [verdad.json]
 *
 * Ataques inyectados:
 *   1) FUERZA BRUTA  (min 60-66): una IP martillea POST /login -> 401 (onda en auth_fail)
 *   2) ESCANEO LENTO (min 100-135): 404 subiendo poco a poco -> cambio de cauce
 *   3) EXFILTRACIÓN  (min 150-154): descargas enormes -> onda en bytes de salida
 */
const fs = require('fs');

const OUT = process.argv[2] || 'access.log';
const TRUTH = process.argv[3] || null;
const MIN = 200;                 // minutos de log
const START = new Date('2026-11-24T02:00:00Z').getTime();
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// PRNG determinista
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
const PATHS = ['/', '/index.html', '/products', '/about', '/api/items', '/api/user', '/static/app.js', '/static/style.css', '/img/logo.png', '/cart'];
const SCAN_PATHS = ['/admin', '/wp-login.php', '/.env', '/phpmyadmin', '/config.php', '/backup.zip', '/.git/config', '/api/v1/secret'];

const ip = () => `${ri(10,220)}.${ri(0,255)}.${ri(0,255)}.${ri(1,254)}`;
const ts = (ms) => { const d = new Date(ms); const p = n => String(n).padStart(2,'0');
  return `${p(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };
const line = (cip, ms, method, path, status, bytes, ua) =>
  `${cip} - - [${ts(ms)}] "${method} ${path} HTTP/1.1" ${status} ${bytes} "-" "${ua}"`;

const out = [];
const truth = [];
const ATTACKER = '203.0.113.77'; // la IP mala (fuerza bruta + escaneo)

for (let m = 0; m < MIN; m++) {
  const minMs = START + m * 60000;
  const lines = []; // {ms, text}

  // --- tráfico normal: ritmo con vaivén diurno + ruido ---
  const rate = Math.round(26 + 12 * Math.sin(m / 28) + (rnd() - 0.5) * 8);
  for (let k = 0; k < Math.max(5, rate); k++) {
    const ms = minMs + ri(0, 59999);
    const r = rnd();
    let path = pick(PATHS), status = 200, bytes = ri(400, 6000), method = 'GET';
    if (r < 0.04) { status = 404; bytes = ri(200, 500); path = '/' + pick(['old','promo2019','favicon2.ico']); } // 404 normales
    else if (r < 0.06) { method = 'POST'; path = '/login'; status = rnd() < 0.3 ? 401 : 200; bytes = ri(300, 900); } // logins normales
    lines.push({ ms, text: line(ip(), ms, method, path, status, bytes, pick(UAS)) });
  }

  // --- ATAQUE 1: fuerza bruta de credenciales (min 60-66) ---
  if (m >= 60 && m <= 66) {
    const hits = ri(70, 95);
    for (let k = 0; k < hits; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(ATTACKER, ms, 'POST', '/login', 401, ri(280, 340), UAS[0]) }); }
    if (m === 60) truth.push({ min: m, type: 'fuerza_bruta', canal: 'auth_fail' });
  }

  // --- ATAQUE 2: escaneo lento, 404 creciente (min 100-135) ---
  if (m >= 100 && m <= 135) {
    const intensidad = Math.round(3 + (m - 100) * 0.7); // sube poco a poco
    for (let k = 0; k < intensidad; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line(ATTACKER, ms, 'GET', pick(SCAN_PATHS), 404, ri(150, 400), UAS[2]) }); }
    if (m === 100) truth.push({ min: m, type: 'escaneo_lento', canal: 'not_found' });
  }

  // --- ATAQUE 3: exfiltración de datos (min 150-154): pocas descargas ENORMES ---
  if (m >= 150 && m <= 154) {
    const grabs = ri(3, 6);
    for (let k = 0; k < grabs; k++) { const ms = minMs + ri(0, 59999);
      lines.push({ ms, text: line('198.51.100.23', ms, 'GET', '/api/export?all=1', 200, ri(8_000_000, 45_000_000), UAS[1]) }); }
    if (m === 150) truth.push({ min: m, type: 'exfiltracion', canal: 'bytes_mb' });
  }

  lines.sort((a, b) => a.ms - b.ms);
  for (const l of lines) out.push(l.text);
}

fs.writeFileSync(OUT, out.join('\n') + '\n');
console.log(`Log generado: ${OUT}  (${out.length} líneas, ${MIN} minutos)`);
if (TRUTH) { fs.writeFileSync(TRUTH, JSON.stringify(truth, null, 2)); console.log(`Verdad oculta: ${TRUTH}`); }
console.log('Ataques escondidos:', truth.map(t => `${t.type}@min${t.min}`).join(', '));
