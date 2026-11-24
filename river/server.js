'use strict';
/*
 * Dashboard EN VIVO del RÍO.
 *
 * El servidor hace fluir un río sintético en tiempo real y transmite cada
 * muestra al navegador por SSE (Server-Sent Events). El navegador dibuja el
 * caudal, la banda de "normalidad" aprendida, y marca ONDAS (piedras) y
 * cambios de CAUCE en el instante en que ocurren.
 *
 * Tú controlas el río: botones para tirar una piedra y para desviar el cauce.
 *
 *   node river/server.js        -> http://localhost:7070
 */
const http = require('http');
const { RiverDetector } = require('./detector');
const { makeRiver } = require('./simulate');

const PORT = Number(process.env.RIVER_PORT || 7070);
const HOST = '0.0.0.0';
const TICK_MS = 100; // 10 muestras/seg

// Estado del río compartido por todos los clientes conectados.
const river = makeRiver({ base: 100, noise: 4, seed: Date.now() });
const det = new RiverDetector(); // parámetros por defecto, validados sobre 30 ríos
let pendingStone = 0; // magnitud de la próxima piedra (se consume en un tick)

const clients = new Set();

setInterval(() => {
  let x = river.tick();
  if (pendingStone) { x += pendingStone; pendingStone = 0; }
  const r = det.push(x);
  const line = 'data: ' + JSON.stringify(r) + '\n\n';
  for (const res of clients) res.write(line);
}, TICK_MS);

const page = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>RÍO · en vivo</title><style>
:root{--b:#070a0f;--p:#0e131c;--l:#26303f;--t:#eef2f8;--m:#8b97ab;--a:#ff8a1f;--ok:#5ddb83;--bad:#ff686b;--blue:#49c2ff}
*{box-sizing:border-box}body{margin:0;background:var(--b);color:var(--t);font:14px system-ui}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-bottom:1px solid var(--l)}
h1{margin:0;font-size:20px;letter-spacing:.08em}h1 b{color:var(--a)}
.wrap{padding:18px 22px;max-width:1100px;margin:0 auto}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
button{font:inherit;font-weight:700;border:0;border-radius:9px;padding:10px 15px;cursor:pointer;color:#111}
.stone{background:var(--blue)}.divUp{background:var(--a)}.divDn{background:#c98a5a}.reset{background:#2a3444;color:var(--t)}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
.card{background:var(--p);border:1px solid var(--l);border-radius:12px;padding:12px 14px}
.card .k{font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:.08em}
.card .v{font-size:22px;font-weight:800;margin-top:4px}
canvas{width:100%;height:360px;background:var(--p);border:1px solid var(--l);border-radius:14px;display:block}
.log{margin-top:14px;background:var(--p);border:1px solid var(--l);border-radius:12px;padding:12px 14px;max-height:200px;overflow:auto;font-family:ui-monospace,monospace;font-size:12.5px}
.log .onda{color:var(--blue)}.log .cauce{color:var(--a)}.muted{color:var(--m)}
@media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><h1><b>Ω</b> RÍO · detección en vivo</h1><span class="muted" id="conn">conectando…</span></header>
<div class="wrap">
<div class="bar">
  <button class="stone" onclick="act('stone',30)">🪨 Tirar piedra</button>
  <button class="stone" onclick="act('stone',60)">🪨 Piedra grande</button>
  <button class="divUp" onclick="act('divert',12)">↗ Desviar cauce +</button>
  <button class="divDn" onclick="act('divert',-12)">↘ Desviar cauce −</button>
  <button class="reset" onclick="logEl.innerHTML=''">Limpiar registro</button>
</div>
<div class="cards">
  <div class="card"><div class="k">Caudal actual</div><div class="v" id="cVal">—</div></div>
  <div class="card"><div class="k">Normal aprendido</div><div class="v" id="cMean">—</div></div>
  <div class="card"><div class="k">Desviación (z)</div><div class="v" id="cZ">—</div></div>
  <div class="card"><div class="k">Estado</div><div class="v" id="cState">—</div></div>
</div>
<canvas id="cv" width="1060" height="360"></canvas>
<div class="log" id="log"><div class="muted">Esperando flujo… aprende lo normal durante ~30 muestras y luego juzga.</div></div>
</div>
<script>
const cv=document.getElementById('cv'),x=cv.getContext('2d'),W=cv.width,H=cv.height;
const logEl=document.getElementById('log');
const buf=[];const MAX=260;
function act(kind,mag){fetch('/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mag})})}
function addLog(html,cls){const d=document.createElement('div');d.className=cls;d.innerHTML=html;logEl.insertBefore(d,logEl.firstChild)}
function draw(){
  x.clearRect(0,0,W,H);
  if(buf.length<2)return;
  const vals=buf.map(p=>p.value),means=buf.map(p=>p.mean),devs=buf.map(p=>p.dev);
  let lo=Math.min(...vals,...means),hi=Math.max(...vals,...means);const pad=(hi-lo)*0.15+1;lo-=pad;hi+=pad;
  const X=i=>i/(MAX-1)*W, Y=v=>H-(v-lo)/(hi-lo)*H;
  // banda de normalidad (media ± 4·dev·1.2533)
  x.beginPath();for(let i=0;i<buf.length;i++){const b=4*devs[i]*1.2533;x.lineTo(X(i),Y(means[i]+b))}
  for(let i=buf.length-1;i>=0;i--){const b=4*devs[i]*1.2533;x.lineTo(X(i),Y(means[i]-b))}
  x.closePath();x.fillStyle='rgba(73,194,255,.10)';x.fill();
  // línea del caudal normal
  x.beginPath();means.forEach((m,i)=>x.lineTo(X(i),Y(m)));x.strokeStyle='#49c2ff';x.lineWidth=1.5;x.stroke();
  // caudal real
  x.beginPath();vals.forEach((v,i)=>x.lineTo(X(i),Y(v)));x.strokeStyle='#eef2f8';x.lineWidth=1.8;x.stroke();
  // marcas de evento
  buf.forEach((p,i)=>{if(p.ripple){x.fillStyle='#49c2ff';x.beginPath();x.arc(X(i),Y(p.value),5,0,7);x.fill()}
    if(p.shift){x.strokeStyle='#ff8a1f';x.lineWidth=2;x.beginPath();x.moveTo(X(i),0);x.lineTo(X(i),H);x.stroke()}});
}
const es=new EventSource('/stream');
es.onopen=()=>document.getElementById('conn').textContent='en vivo ●';
es.onerror=()=>document.getElementById('conn').textContent='reconectando…';
es.onmessage=e=>{const p=JSON.parse(e.data);buf.push(p);if(buf.length>MAX)buf.shift();
  document.getElementById('cVal').textContent=p.value.toFixed(1);
  document.getElementById('cMean').textContent=p.ready?p.mean.toFixed(1):'aprendiendo';
  document.getElementById('cZ').textContent=p.ready?p.z.toFixed(2):'—';
  const st=document.getElementById('cState');
  if(!p.ready){st.textContent='aprendiendo';st.style.color='#8b97ab'}
  else if(p.ripple){st.textContent='¡ONDA!';st.style.color='#49c2ff'}
  else if(p.shift){st.textContent='CAUCE CAMBIÓ';st.style.color='#ff8a1f'}
  else{st.textContent='fluyendo';st.style.color='#5ddb83'}
  if(p.ripple)addLog('t='+p.t+' · <b>ONDA</b> detectada · z='+p.z.toFixed(1)+' · caudal='+p.value.toFixed(1)+' (normal≈'+p.mean.toFixed(1)+')','onda');
  if(p.shift)addLog('t='+p.t+' · <b>CAUCE</b> cambió ('+p.shiftDir+') · cusum='+p.cusum.toFixed(1),'cauce');
  draw();
};
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && (req.url === '/stone' || req.url === '/divert')) {
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      let mag = 0; try { mag = Number(JSON.parse(b || '{}').mag) || 0; } catch {}
      mag = Math.max(-200, Math.min(200, mag));
      if (req.url === '/stone') pendingStone += mag; else river.divert(mag);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    });
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => console.log('RÍO dashboard en http://localhost:' + PORT));
