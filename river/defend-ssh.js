'use strict';
/*
 * DEFENSA COMPLETA sobre log SSH real: detectar + RESPONDER (bloquear IP).
 *   node river/defend-ssh.js <ssh.log> [--enforce]
 *
 * Por defecto SIMULA (genera las reglas iptables, no las ejecuta). Con
 * --enforce ejecutaría de verdad vía iptables (sólo donde tengas permisos y
 * sea tu propio sistema); aquí el enforcer real está deshabilitado a propósito
 * para no tocar el firewall de un contenedor que no es tuyo.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const { RiverField } = require('./field');
const { Responder } = require('./responder');

const LOG = process.argv[2];
const ENFORCE = process.argv.includes('--enforce');
if (!LOG) { console.error('uso: node river/defend-ssh.js <ssh.log> [--enforce]'); process.exit(1); }

// parse SSH (igual que ingest-ssh)
const MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
const reTs = /^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;
const reIp = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
const buckets = new Map(); let t0 = null;
for (const ln of fs.readFileSync(LOG, 'utf8').split('\n')) {
  const m = ln.match(reTs); if (!m) continue;
  const ts = Date.UTC(2016, MON[m[1]], +m[2], +m[3], +m[4], +m[5]);
  if (t0 == null) t0 = ts; const mi = Math.floor((ts - t0) / 60000);
  let b = buckets.get(mi); if (!b) { b = { failed: 0, invalid: 0, ips: new Set(), topIp: {} }; buckets.set(mi, b); }
  if (ln.includes('Failed password')) b.failed++;
  if (ln.includes('Invalid user')) b.invalid++;
  const ip = ln.match(reIp); if (ip) { b.ips.add(ip[1]); b.topIp[ip[1]] = (b.topIp[ip[1]] || 0) + 1; }
}

// enforcer real (opt-in) — sólo si pasas --enforce Y tienes permisos reales.
function realEnforcer(action, ip) {
  const args = action === 'add'
    ? ['-A', 'INPUT', '-s', ip, '-j', 'DROP']
    : ['-D', 'INPUT', '-s', ip, '-j', 'DROP'];
  try { execFileSync('iptables', args, { stdio: 'ignore' }); return { executed: true, cmd: 'iptables ' + args.join(' ') }; }
  catch (e) { return { executed: false, cmd: 'iptables ' + args.join(' '), error: String(e.message || e).slice(0, 80) }; }
}

const cnt = { halfLife: 15, warmup: 20, rippleZ: 4, cusumH: 5, poisson: true };
const field = new RiverField([
  { name: 'failed', opts: cnt }, { name: 'invalid_user', opts: cnt }, { name: 'unique_ips', opts: cnt }
], { corrWindow: 3, corrMin: 2 });

const responder = new Responder({
  blockTTL: 3600, maxPerWindow: 10, windowSec: 60,
  allowlist: ['203.0.113.0/24'],              // ejemplo: una red de confianza
  enforcer: ENFORCE ? realEnforcer : undefined // undefined = simulación
});

console.log(`Modo: ${ENFORCE ? 'EJECUCIÓN REAL (iptables)' : 'SIMULACIÓN (no toca el firewall)'}\n`);
const maxMin = Math.max(...buckets.keys());
const run = {}; // persistencia por canal para la regla "persistente >=2 min"
for (let mi = 0; mi <= maxMin; mi++) {
  const b = buckets.get(mi) || { failed: 0, invalid: 0, ips: new Set(), topIp: {} };
  const r = field.push({ failed: b.failed, invalid_user: b.invalid, unique_ips: b.ips.size });
  // ALERTA = correlacionada o anomalía persistente >=2 min
  let persist = false;
  for (const n of ['failed', 'invalid_user', 'unique_ips']) {
    const v = r.channels[n];
    if (v && (v.ripple || v.shift)) { run[n] = (run[n] || 0) + 1; if (run[n] >= 2) persist = true; } else run[n] = 0;
  }
  if (r.correlated || persist) {
    const top = Object.entries(b.topIp).sort((a, c) => c[1] - a[1])[0];
    if (top) {
      const d = responder.consider(top[0], `SSH brute force (m${mi}, ${top[1]} intentos)`);
      const icon = { bloqueada: '⛔', ya_bloqueada: '•', protegida: '🛡', diferida: '⏸', ignorada: '·' }[d.action] || '?';
      console.log(`m${String(mi).padStart(3)} ${icon} ${d.action.toUpperCase().padEnd(13)} ${d.ip.padEnd(16)} ${d.cmd || d.note || ''}`);
    }
  }
}

console.log('\n=== LISTA DE BLOQUEO ACTIVA ===');
for (const e of responder.blocklist()) console.log(`  ${e.ip.padEnd(16)} caduca en ${e.expiresInSec}s  (${e.reason})`);
const blocked = responder.log.filter(l => l.action === 'bloqueada').length;
const prot = responder.log.filter(l => l.action === 'protegida').length;
const dup = responder.log.filter(l => l.action === 'ya_bloqueada').length;
console.log(`\nResumen: ${blocked} IP(s) bloqueada(s), ${dup} reintento(s) deduplicado(s), ${prot} protegida(s) por lista blanca.`);
