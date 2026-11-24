'use strict';
/*
 * REPLAY — reproduce un log SSH REAL a través de los ríos, en vivo, y muestra
 * la detección minuto a minuto con la IP del atacante señalada.
 *
 *   node river/replay.js <ssh.log>   -> http://localhost:7072
 */
const http = require('http');
const fs = require('fs');
const { RiverField } = require('./field');

const PORT = Number(process.env.REPLAY_PORT || 7072);
const TICK_MS = 80;
const LOG = process.argv[2];
if (!LOG) { console.error('uso: node river/replay.js <ssh.log>'); process.exit(1); }

// --- parse del log SSH en buckets por minuto ---
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
const maxMin = Math.max(...buckets.keys());

const cnt = { halfLife: 15, warmup: 20, rippleZ: 4, cusumH: 5, poisson: true };
const clients = new Set();
let field, cursor;
function reset() {
  field = new RiverField([
    { name: 'failed', opts: cnt }, { name: 'invalid_user', opts: cnt }, { name: 'unique_ips', opts: cnt }
  ], { corrWindow: 3, corrMin: 2 });
  cursor = 0;
}
reset();

setInterval(() => {
  if (cursor > maxMin) reset();
  const b = buckets.get(cursor) || { failed: 0, invalid: 0, ips: new Set(), topIp: {} };
  const r = field.push({ failed: b.failed, invalid_user: b.invalid, unique_ips: b.ips.size });
  const top = Object.entries(b.topIp).sort((a, c) => c[1] - a[1])[0];
  const payload = { min: cursor, r, failed: b.failed, ips: b.ips.size, topIp: top ? top[0] : null, topHits: top ? top[1] : 0 };
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of clients) res.write(line);
  cursor++;
}, TICK_MS);

const page = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>RÍO · replay SSH real</title><style>
:root{--b:#070a0f;--p:#0e131c;--l:#26303f;--t:#eef2f8;--m:#8b97ab;--a:#ff8a1f;--ok:#5ddb83;--bad:#ff686b;--blue:#49c2ff}
*{box-sizing:border-box}body{margin:0;background:var(--b);color:var(--t);font:14px system-ui}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-bottom:1px solid var(--l)}
h1{margin:0;font-size:19px;letter-spacing:.06em}h1 b{color:var(--a)}
.wrap{padding:18px 22px;max-width:1080px;margin:0 auto}
.banner{border-radius:14px;padding:16px 20px;margin-bottom:14px;font-weight:800;font-size:17px;border:1px solid var(--l)}
.banner.ok{background:rgba(93,219,131,.08);color:var(--ok)}
.banner.warn{background:rgba(255,138,31,.10);color:var(--a)}
.banner.alert{background:rgba(255,104,107,.14);color:var(--bad);border-color:var(--bad)}
.culprit{display:none;background:#1a0d0f;border:1px solid var(--bad);border-radius:12px;padding:12px 16px;margin-bottom:14px;font-family:ui-monospace,monospace}
.culprit.on{display:block}.culprit b{color:var(--bad);font-size:18px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.ch{background:var(--p);border:1px solid var(--l);border-radius:12px;padding:12px}.ch.hot{border-color:var(--a)}
.ch .name{font-size:12px;color:var(--m);text-transform:uppercase;letter-spacing:.06em}
.ch .val{font-size:22px;font-weight:800;margin:2px 0 6px}.ch .st{font-size:11px;font-weight:700}
.ch canvas{width:100%;height:70px;display:block;margin-top:8px}
.foot{margin-top:12px;color:var(--m);font-size:12px}
@media(max-width:720px){.grid{grid-template-columns:1fr}}
</style></head><body>
<header><h1><b>Ω</b> RÍO · replay de log SSH REAL</h1><span class="muted" id="conn" style="color:var(--m)">conectando…</span></header>
<div class="wrap">
<div class="banner ok" id="banner">Reproduciendo tráfico real…</div>
<div class="culprit" id="culprit"></div>
<div class="grid" id="grid"></div>
<div class="foot" id="foot">Datos: OpenSSH real (loghub). El detector es ciego; marca la ráfaga y nombra la IP dominante del minuto.</div>
</div>
<script>
const CH=['failed','invalid_user','unique_ips'],NAMES={failed:'Fallos de login',invalid_user:'Usuarios inválidos',unique_ips:'IPs únicas'};
const grid=document.getElementById('grid'),banner=document.getElementById('banner'),culprit=document.getElementById('culprit');
const hist={};CH.forEach(n=>{hist[n]=[];const d=document.createElement('div');d.className='ch';d.id='ch-'+n;
  d.innerHTML='<div class="name">'+NAMES[n]+'</div><div class="val" id="v-'+n+'">—</div><div class="st" id="s-'+n+'">—</div><canvas id="c-'+n+'" width="320" height="140"></canvas>';grid.appendChild(d)});
function spark(n){const cv=document.getElementById('c-'+n),x=cv.getContext('2d'),W=cv.width,H=cv.height,h=hist[n];x.clearRect(0,0,W,H);if(h.length<2)return;
  const vals=h.map(p=>p.value),means=h.map(p=>p.mean);let lo=Math.min(...vals,...means),hi=Math.max(...vals,...means);const pad=(hi-lo)*0.2+1e-6;lo-=pad;hi+=pad;
  const X=i=>i/(h.length-1)*W,Y=v=>H-(v-lo)/(hi-lo)*H;
  x.beginPath();means.forEach((m,i)=>x.lineTo(X(i),Y(m)));x.strokeStyle='#49c2ff';x.lineWidth=1;x.stroke();
  x.beginPath();vals.forEach((v,i)=>x.lineTo(X(i),Y(v)));x.strokeStyle='#eef2f8';x.lineWidth=1.4;x.stroke();
  h.forEach((p,i)=>{if(p.ripple){x.fillStyle='#49c2ff';x.beginPath();x.arc(X(i),Y(p.value),3,0,7);x.fill()}if(p.shift){x.strokeStyle='#ff8a1f';x.lineWidth=1.5;x.beginPath();x.moveTo(X(i),0);x.lineTo(X(i),H);x.stroke()}})}
let lastCorrAt=0,lastMsg='',lastCulprit='';const STICKY=2500;
const es=new EventSource('/stream');
es.onopen=()=>document.getElementById('conn').textContent='en vivo ●';
es.onmessage=e=>{const d=JSON.parse(e.data),r=d.r;let anyHot=false,hot=[];
  CH.forEach(n=>{const p=r.channels[n];if(!p)return;hist[n].push(p);if(hist[n].length>80)hist[n].shift();
    document.getElementById('v-'+n).textContent=p.value.toFixed(0);const st=document.getElementById('s-'+n),card=document.getElementById('ch-'+n);card.classList.remove('hot');
    if(!p.ready){st.textContent='aprendiendo';st.style.color='#8b97ab'}
    else if(p.ripple){st.textContent='¡ONDA!';st.style.color='#49c2ff';card.classList.add('hot');anyHot=true;hot.push(n)}
    else if(p.shift){st.textContent='CAUCE';st.style.color='#ff8a1f';card.classList.add('hot');anyHot=true;hot.push(n)}
    else{st.textContent='normal';st.style.color='#5ddb83'}spark(n)});
  if(r.correlated){lastCorrAt=Date.now();lastMsg='⚠ ATAQUE DETECTADO (min '+d.min+') — '+r.culprits.join(' + ')+' a la vez';
    if(d.topIp)lastCulprit='ATACANTE señalado: <b>'+d.topIp+'</b> · '+d.topHits+' intentos en este minuto · '+d.failed+' fallos de login'}
  if(Date.now()-lastCorrAt<STICKY){banner.className='banner alert';banner.textContent=lastMsg;culprit.className='culprit on';culprit.innerHTML=lastCulprit}
  else if(anyHot){banner.className='banner warn';banner.textContent='Anomalía (min '+d.min+'): '+hot.map(n=>NAMES[n]).join(', ');
    if(d.topIp&&d.failed>3){culprit.className='culprit on';culprit.innerHTML='IP dominante: <b>'+d.topIp+'</b> · '+d.topHits+' intentos · '+d.failed+' fallos'}else culprit.className='culprit'}
  else{banner.className='banner ok';banner.textContent='Tráfico normal (min '+d.min+')';culprit.className='culprit'}
};
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
});
server.listen(PORT, '0.0.0.0', () => console.log('RÍO replay en http://localhost:' + PORT + '  (' + buckets.size + ' minutos de log real)'));
