'use strict';
/*
 * MONITOR — dashboard multi-río en vivo con detección de correlación.
 *   node river/monitor.js   -> http://localhost:7071
 *
 * Cinco señales de un sistema fluyen en paralelo. Cada una es un río con su
 * propia detección de onda y cauce. Arriba, un banner declara el estado global
 * y SE PONE ROJO cuando varias señales se mueven juntas (evento correlacionado).
 */
const http = require('http');
const { RiverField } = require('./field');
const { makeRng, gauss } = require('./simulate');

const PORT = Number(process.env.MONITOR_PORT || 7071);
const TICK_MS = 100;

const CH = ['cpu', 'red_in', 'red_out', 'logins', 'latencia'];
const base = { cpu: 30, red_in: 500, red_out: 300, logins: 5, latencia: 40 };
const noise = { cpu: 3, red_in: 40, red_out: 25, logins: 1.2, latencia: 4 };

const field = new RiverField(CH.map(n => ({ name: n })), { corrWindow: 6, corrMin: 2 });
const rng = makeRng(Date.now());
const inject = {};           // canal -> unidades extra para el próximo tick
let attackTicks = 0;         // ticks restantes de ataque coordinado

const clients = new Set();

setInterval(() => {
  const s = {};
  for (const n of CH) s[n] = base[n] + gauss(rng) * noise[n];
  // inyecciones puntuales (ruido suelto)
  for (const n in inject) { s[n] += inject[n]; delete inject[n]; }
  // ataque coordinado sostenido
  if (attackTicks > 0) { s.cpu += 25; s.red_in += 350; s.logins += 12; attackTicks--; }

  const r = field.push(s);
  const line = 'data: ' + JSON.stringify(r) + '\n\n';
  for (const res of clients) res.write(line);
}, TICK_MS);

const page = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>RÍO · monitor</title><style>
:root{--b:#070a0f;--p:#0e131c;--l:#26303f;--t:#eef2f8;--m:#8b97ab;--a:#ff8a1f;--ok:#5ddb83;--bad:#ff686b;--blue:#49c2ff}
*{box-sizing:border-box}body{margin:0;background:var(--b);color:var(--t);font:14px system-ui}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-bottom:1px solid var(--l)}
h1{margin:0;font-size:20px;letter-spacing:.08em}h1 b{color:var(--a)}
.wrap{padding:18px 22px;max-width:1120px;margin:0 auto}
.banner{border-radius:14px;padding:16px 20px;margin-bottom:16px;font-weight:800;font-size:18px;border:1px solid var(--l);transition:.2s}
.banner.ok{background:rgba(93,219,131,.08);color:var(--ok)}
.banner.warn{background:rgba(255,138,31,.10);color:var(--a)}
.banner.alert{background:rgba(255,104,107,.14);color:var(--bad);border-color:var(--bad)}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
button{font:inherit;font-weight:700;border:0;border-radius:9px;padding:10px 15px;cursor:pointer;color:#111}
.noise{background:var(--blue)}.attack{background:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.ch{background:var(--p);border:1px solid var(--l);border-radius:12px;padding:12px}
.ch.hot{border-color:var(--a)}.ch.crit{border-color:var(--bad)}
.ch .name{font-size:12px;color:var(--m);text-transform:uppercase;letter-spacing:.06em}
.ch .val{font-size:20px;font-weight:800;margin:2px 0 6px}
.ch .st{font-size:11px;font-weight:700}
.ch canvas{width:100%;height:60px;display:block;margin-top:8px}
.log{margin-top:16px;background:var(--p);border:1px solid var(--l);border-radius:12px;padding:12px 14px;max-height:200px;overflow:auto;font-family:ui-monospace,monospace;font-size:12.5px}
.log .corr{color:var(--bad);font-weight:700}.log .one{color:var(--a)}.muted{color:var(--m)}
@media(max-width:860px){.grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><h1><b>Ω</b> RÍO · monitor multi-canal</h1><span class="muted" id="conn">conectando…</span></header>
<div class="wrap">
<div class="banner ok" id="banner">Sistema normal — todos los ríos fluyen</div>
<div class="bar">
  <button class="noise" onclick="fetch('/noise',{method:'POST'})">🪨 Ruido en 1 canal</button>
  <button class="attack" onclick="fetch('/attack',{method:'POST'})">⚔ Ataque coordinado</button>
  <button class="noise" style="background:#2a3444;color:#eef2f8" onclick="log.innerHTML=''">Limpiar registro</button>
</div>
<div class="grid" id="grid"></div>
<div class="log" id="log"><div class="muted">Esperando flujo… cada río aprende lo normal y luego juzga.</div></div>
</div>
<script>
const CH=${JSON.stringify(CH)};
const grid=document.getElementById('grid'),log=document.getElementById('log'),banner=document.getElementById('banner');
const hist={},cards={};
CH.forEach(n=>{hist[n]=[];
  const d=document.createElement('div');d.className='ch';d.id='ch-'+n;
  d.innerHTML='<div class="name">'+n+'</div><div class="val" id="v-'+n+'">—</div><div class="st" id="s-'+n+'">—</div><canvas id="c-'+n+'" width="300" height="120"></canvas>';
  grid.appendChild(d);cards[n]=d;});
function spark(n){const cv=document.getElementById('c-'+n),x=cv.getContext('2d'),W=cv.width,H=cv.height,h=hist[n];
  x.clearRect(0,0,W,H);if(h.length<2)return;const vals=h.map(p=>p.value),means=h.map(p=>p.mean);
  let lo=Math.min(...vals,...means),hi=Math.max(...vals,...means);const pad=(hi-lo)*0.2+1e-6;lo-=pad;hi+=pad;
  const X=i=>i/(h.length-1)*W,Y=v=>H-(v-lo)/(hi-lo)*H;
  x.beginPath();means.forEach((m,i)=>x.lineTo(X(i),Y(m)));x.strokeStyle='#49c2ff';x.lineWidth=1;x.stroke();
  x.beginPath();vals.forEach((v,i)=>x.lineTo(X(i),Y(v)));x.strokeStyle='#eef2f8';x.lineWidth=1.4;x.stroke();
  h.forEach((p,i)=>{if(p.ripple){x.fillStyle='#49c2ff';x.beginPath();x.arc(X(i),Y(p.value),3,0,7);x.fill()}
    if(p.shift){x.strokeStyle='#ff8a1f';x.lineWidth=1.5;x.beginPath();x.moveTo(X(i),0);x.lineTo(X(i),H);x.stroke()}});}
function addLog(html,cls){const d=document.createElement('div');d.className=cls;d.innerHTML=html;log.insertBefore(d,log.firstChild)}
let lastCorrAt=0,lastCulprits=[];const STICKY=3500; // el aviso rojo permanece 3,5 s
const es=new EventSource('/stream');
es.onopen=()=>document.getElementById('conn').textContent='en vivo ●';
es.onerror=()=>document.getElementById('conn').textContent='reconectando…';
es.onmessage=e=>{const r=JSON.parse(e.data);let anyHot=false,hotNames=[];
  CH.forEach(n=>{const p=r.channels[n];if(!p)return;hist[n].push(p);if(hist[n].length>120)hist[n].shift();
    document.getElementById('v-'+n).textContent=p.value.toFixed(n==='logins'?1:0);
    const st=document.getElementById('s-'+n),card=cards[n];card.classList.remove('hot','crit');
    if(!p.ready){st.textContent='aprendiendo';st.style.color='#8b97ab'}
    else if(p.ripple){st.textContent='¡ONDA!';st.style.color='#49c2ff';card.classList.add('hot');anyHot=true;hotNames.push(n)}
    else if(p.shift){st.textContent='CAUCE CAMBIÓ';st.style.color='#ff8a1f';card.classList.add('hot');anyHot=true;hotNames.push(n)}
    else{st.textContent='fluyendo';st.style.color='#5ddb83'}
    spark(n);});
  if(r.correlated){lastCorrAt=Date.now();lastCulprits=r.culprits;
    addLog('t='+r.t+' · <b>CORRELACIONADO</b> · '+r.culprits.join(' + '),'corr')}
  else if(anyHot){addLog('t='+r.t+' · anomalía suelta · '+hotNames.join(', '),'one')}
  // El aviso rojo permanece STICKY ms tras el último evento correlacionado.
  if(Date.now()-lastCorrAt<STICKY){banner.className='banner alert';
    banner.textContent='⚠ EVENTO CORRELACIONADO — varios ríos a la vez: '+lastCulprits.join(' + ')}
  else if(anyHot){banner.className='banner warn';banner.textContent='Anomalía puntual en: '+hotNames.join(', ')+' (sin correlación)'}
  else{banner.className='banner ok';banner.textContent='Sistema normal — todos los ríos fluyen'}
};
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.method === 'POST' && req.url === '/noise') { inject.latencia = (inject.latencia || 0) + 45; res.end('{}'); return; }
  if (req.method === 'POST' && req.url === '/attack') { attackTicks = 20; res.end('{}'); return; }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page);
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(PORT, '0.0.0.0', () => console.log('RÍO monitor en http://localhost:' + PORT));
