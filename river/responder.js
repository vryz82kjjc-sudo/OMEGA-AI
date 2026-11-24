'use strict';
/*
 * RESPONDER — respuesta automática: bloquear la IP atacante.
 *
 * Bloquear es una acción que puede volverse en tu contra, así que lleva
 * salvaguardas que los sistemas serios dan por obligatorias:
 *
 *   1) LISTA BLANCA: nunca bloquea rangos internos (10/8, 192.168, 172.16-31,
 *      127, enlace local) ni IPs de confianza que configures. Un fallo aquí te
 *      corta a ti mismo.
 *   2) BLOQUEO TEMPORAL: cada bloqueo caduca (TTL). La defensa no debe acumular
 *      reglas para siempre ni castigar de por vida por una IP reutilizable.
 *   3) ANTI-DUPLICADOS: no reañade una IP ya bloqueada (refresca su caducidad).
 *   4) LÍMITE DE RITMO: un máximo de bloqueos nuevos por ventana, para que un
 *      atacante no provoque una "tormenta de bloqueos" que te deje sin red.
 *   5) SIMULACIÓN por defecto: genera la regla de firewall pero NO la ejecuta.
 *      La ejecución real es opt-in y se conecta con un "enforcer" (iptables,
 *      nftables, un WAF, fail2ban, Cloudflare...). Nunca ejecuta a ciegas.
 */

function ipToLong(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
// Rangos que NUNCA se bloquean (privados / loopback / enlace local).
const RESERVED = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8],
];
function inCidr(ip, base, bits) {
  const a = ipToLong(ip), b = ipToLong(base); if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

// Enforcer por defecto: SIMULA. Devuelve el comando pero no lo ejecuta.
function dryRunEnforcer(action, ip) {
  const cmd = action === 'add'
    ? `iptables -A INPUT -s ${ip} -j DROP`
    : `iptables -D INPUT -s ${ip} -j DROP`;
  return { executed: false, cmd };
}

class Responder {
  /**
   * @param {object} o
   * @param {string[]} o.allowlist   IPs/CIDR extra que nunca se bloquean (ej. "198.51.100.0/24").
   * @param {number}   o.blockTTL    segundos que dura cada bloqueo (por defecto 3600).
   * @param {number}   o.maxPerWindow bloqueos nuevos máximos por ventana (por defecto 10).
   * @param {number}   o.windowSec    tamaño de la ventana del límite de ritmo (por defecto 60).
   * @param {function} o.enforcer     (action,ip,meta) => {executed,cmd}. Por defecto, simulación.
   */
  constructor(o = {}) {
    this.allow = (o.allowlist || []).map(s => {
      const [ip, bits] = s.split('/'); return { ip, bits: bits ? +bits : 32 };
    });
    this.blockTTL = (o.blockTTL ?? 3600) * 1000;
    this.maxPerWindow = o.maxPerWindow ?? 10;
    this.windowMs = (o.windowSec ?? 60) * 1000;
    this.enforcer = o.enforcer || dryRunEnforcer;
    this.active = new Map();   // ip -> {reason, at, expires, cmd}
    this.recentBlocks = [];    // timestamps, para el límite de ritmo
    this.log = [];             // historial de decisiones
  }

  _allowlisted(ip) {
    if (RESERVED.some(([b, n]) => inCidr(ip, b, n))) return 'rango interno/reservado';
    if (this.allow.some(a => inCidr(ip, a.ip, a.bits))) return 'lista blanca';
    return null;
  }

  /**
   * Considera bloquear una IP. Devuelve la decisión (y NO ejecuta nada real si
   * el enforcer es la simulación por defecto).
   * @returns {{action:string, ip:string, reason?:string, cmd?:string, note?:string}}
   */
  consider(ip, reason, now = Date.now()) {
    if (ipToLong(ip) == null) return this._rec({ action: 'ignorada', ip, note: 'IP inválida' });

    const why = this._allowlisted(ip);
    if (why) return this._rec({ action: 'protegida', ip, note: why });

    const cur = this.active.get(ip);
    if (cur && cur.expires > now) { cur.expires = now + this.blockTTL; return this._rec({ action: 'ya_bloqueada', ip, note: 'caducidad refrescada' }); }

    // límite de ritmo
    this.recentBlocks = this.recentBlocks.filter(t => now - t < this.windowMs);
    if (this.recentBlocks.length >= this.maxPerWindow) return this._rec({ action: 'diferida', ip, note: 'límite de ritmo alcanzado' });

    const { executed, cmd } = this.enforcer('add', ip, { reason });
    this.active.set(ip, { reason, at: now, expires: now + this.blockTTL, cmd });
    this.recentBlocks.push(now);
    return this._rec({ action: 'bloqueada', ip, reason, cmd, executed });
  }

  /** Levanta los bloqueos caducados. Llamar periódicamente. */
  sweep(now = Date.now()) {
    const freed = [];
    for (const [ip, b] of this.active) {
      if (b.expires <= now) { this.enforcer('del', ip, {}); this.active.delete(ip); freed.push(ip); }
    }
    return freed;
  }

  blocklist() { return [...this.active.entries()].map(([ip, b]) => ({ ip, reason: b.reason, expiresInSec: Math.round((b.expires - Date.now()) / 1000) })); }
  _rec(d) { this.log.push({ ...d, t: Date.now() }); return d; }
}

module.exports = { Responder, dryRunEnforcer, ipToLong };
