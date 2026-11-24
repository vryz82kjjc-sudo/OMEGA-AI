'use strict';
/*
 * INGESTOR para logs SSH REALES (formato syslog de sshd). Datos sin preparar:
 * un servidor de verdad bajo fuerza bruta real. Sin etiquetas: el detector
 * marca los minutos anómalos y corroboramos con la evidencia cruda.
 *
 *   node river/ingest-ssh.js <ssh.log>
 *
 * Canales por minuto (conteo, con suelo de Poisson):
 *   failed       "Failed password"
 *   invalid_user "Invalid user"
 *   unique_ips   IPs fuente distintas
 */
const fs = require('fs');
const { RiverField } = require('./field');

const LOG = process.argv[2];
if (!LOG) { console.error('uso: node river/ingest-ssh.js <ssh.log>'); process.exit(1); }

const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
const reTs = /^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;
const reIp = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

const buckets = new Map();
let t0 = null;
for (const ln of fs.readFileSync(LOG, 'utf8').split('\n')) {
  const m = ln.match(reTs); if (!m) continue;
  const ts = Date.UTC(2016, MON[m[1]], +m[2], +m[3], +m[4], +m[5]); // año asumido
  if (t0 == null) t0 = ts;
  const mi = Math.floor((ts - t0) / 60000);
  let b = buckets.get(mi); if (!b) { b = { failed: 0, invalid: 0, ips: new Set(), topIp: {} }; buckets.set(mi, b); }
  if (ln.includes('Failed password')) b.failed++;
  if (ln.includes('Invalid user')) b.invalid++;
  const ip = ln.match(reIp); if (ip) { b.ips.add(ip[1]); b.topIp[ip[1]] = (b.topIp[ip[1]] || 0) + 1; }
}

const cnt = { halfLife: 15, warmup: 20, rippleZ: 4, cusumH: 5, poisson: true };
const field = new RiverField([
  { name: 'failed',       opts: cnt },
  { name: 'invalid_user', opts: cnt },
  { name: 'unique_ips',   opts: cnt },
], { corrWindow: 3, corrMin: 2 });

const maxMin = Math.max(...buckets.keys());
const hot = [];
for (let mi = 0; mi <= maxMin; mi++) {
  const b = buckets.get(mi) || { failed: 0, invalid: 0, ips: new Set(), topIp: {} };
  const r = field.push({ failed: b.failed, invalid_user: b.invalid, unique_ips: b.ips.size });
  const ch = Object.entries(r.channels).filter(([, v]) => v && (v.ripple || v.shift)).map(([k]) => k);
  if (ch.length) {
    const top = Object.entries(b.topIp).sort((a, c) => c[1] - a[1])[0];
    hot.push({ mi, ch, corr: r.correlated, culprits: r.culprits, failed: b.failed, ips: b.ips.size, topIp: top ? `${top[0]}(${top[1]})` : '-' });
  }
}

console.log(`=== LOG SSH REAL: ${buckets.size} minutos, detección ciega ===\n`);
console.log('min | canales anómalos            | fallos | IPs | IP dominante          | correlación');
console.log('-'.repeat(92));
for (const h of hot) {
  console.log(
    String(h.mi).padStart(3) + ' | ' +
    h.ch.join(',').padEnd(28) + ' | ' +
    String(h.failed).padStart(6) + ' | ' +
    String(h.ips).padStart(3) + ' | ' +
    h.topIp.padEnd(21) + ' | ' +
    (h.corr ? 'SÍ ('+h.culprits.join('+')+')' : '')
  );
}
console.log(`\n${hot.length} minuto(s) marcados como anómalos sobre datos reales sin etiquetar.`);
