'use strict';
/** Mi Inversión IA · Motor de agentes transparente. Sin órdenes, sin scraping de portales restringidos. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https=require('node:https');
const dns=require('node:dns');
const net=require('node:net');
const zlib=require('node:zlib');
const {URL} = require('node:url');

const PORT = Number(process.env.PORT || 10000);
const HERE = __dirname;
const FRONTEND_ORIGIN = 'https://mi-inversion-ia.onrender.com';
const ALLOWED_ORIGINS = new Set([FRONTEND_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000','http://localhost:10000']);
const MAX_BODY = 160_000;
const AGENTS = [
  {id:'A01',name:'Director de operaciones',department:'Gobernanza',mission:'Organiza el expediente y dirige la secuencia de análisis.'},
  {id:'A02',name:'Extractor de anuncios',department:'Datos',mission:'Convierte información del anuncio en campos revisables.'},
  {id:'A03',name:'Valorador de mercado',department:'Mercado',mission:'Compara referencias aportadas sin inventar precios.'},
  {id:'A04',name:'Auditor de riesgos',department:'Diligencia',mission:'Detecta indicios que necesitan comprobación profesional.'},
  {id:'A05',name:'Analista financiero',department:'Finanzas',mission:'Calcula entrada, impuestos estimados, préstamo y cuota.'},
  {id:'A06',name:'Negociador comprador',department:'Negociación',mission:'Prepara una propuesta editable sin enviarla.'},
  {id:'A07',name:'Comparador hipotecario',department:'Financiación',mission:'Compara ofertas introducidas y advierte de campos faltantes.'},
  {id:'A08',name:'Gestor de visitas',department:'Operaciones',mission:'Prepara comprobaciones para la visita.'},
  {id:'A09',name:'Revisor documental',department:'Legal',mission:'Lista documentación a solicitar y riesgos de arras.'},
  {id:'A10',name:'Coordinador de firma',department:'Cierre',mission:'Ordena FEIN, tasación, elección de notario y firma.'},
  {id:'A11',name:'Auditor independiente',department:'Control',mission:'Evalúa calidad de fuentes y bloquea conclusiones infundadas.'}
];
const SOURCES = [
  {name:'Sede Electrónica del Catastro',category:'Inmueble y cartografía',url:'https://www.sedecatastro.gob.es/',connected:'enlace_oficial',notes:'Consulta pública de datos no protegidos. No equivale al Registro.'},
  {name:'Banco de España · Portal del Cliente Bancario',category:'Hipotecas y educación financiera',url:'https://clientebancario.bde.es/',connected:'enlace_oficial',notes:'Información general; no ofertas bancarias integradas.'},
  {name:'Consejo General del Notariado',category:'Notaría y elección',url:'https://www.notariado.org/',connected:'enlace_oficial',notes:'Acceso al portal oficial. Sin agendas de citas conectadas.'},
  {name:'Colegio de Registradores',category:'Registro de la Propiedad',url:'https://www.registradores.org/',connected:'enlace_oficial',notes:'Los datos registrales requieren los trámites y pagos aplicables.'},
  {name:'Instituto Nacional de Estadística',category:'Estadísticas de vivienda',url:'https://www.ine.es/',connected:'enlace_oficial',notes:'Información estadística, no tasación individual.'},
  {name:'BOE · Boletín Oficial del Estado',category:'Legislación',url:'https://www.boe.es/',connected:'enlace_oficial',notes:'Normativa oficial, interpretación legal por profesional.'}
];
const euro = n => Math.round(Number(n)||0);
const fixed = (n,p=2)=>Number(Number(n).toFixed(p));
const clamp = (n,min,max,def)=>Number.isFinite(Number(n))?Math.min(max,Math.max(min,Number(n))):def;
function clean(x,max=300){return String(x??'').replace(/[\u0000-\u001f<>]/g,' ').trim().slice(0,max)}
function parseMoney(raw){
 const s=String(raw||'').replace(/[^\d.,]/g,'');if(!s)return 0;
 if(/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s))return Number(s.replace(/\./g,'').replace(',','.'))||0;
 if(/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s))return Number(s.replace(/,/g,''))||0;
 if(s.includes(','))return Number(s.replace(/\./g,'').replace(',','.'))||0;
 return Number(s)||0;
}
function extractListing(text){
  const s=clean(text,3500);
  const candidates=[...s.matchAll(/(?:precio|venta|pvp|importe)?\s*[:\-]?\s*([\d.]+(?:,\d{1,2})?)\s*(?:€|euros?)/gi)]
    .map(m=>parseMoney(m[1])).filter(v=>v>5000 && v<100000000);
  const area=s.match(/(\d{2,5}(?:[.,]\d+)?)\s*(?:m²|m2|metros\s+cuadrados)/i);
  const rooms=s.match(/(\d{1,2})\s*(?:habita(?:ci[oó]n|ciones)|dormitorios?)/i);
  return {price:candidates[0]||null,area:area?parseMoney(area[1]):null,rooms:rooms?Number(rooms[1]):null,
    alert:'Extracción orientativa del texto proporcionado. Verifica manualmente todos los campos y la fuente.'};
}

/** Public, read-only listing import. No logins, CAPTCHA evasion or restricted data. */
const MAX_LISTING_HTML=1500000;
function entities(v){return String(v??'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|euro|ntilde);/gi,(all,k)=>{
 const m={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',euro:'€',ntilde:'ñ'};
 if(k[0]==='#'){const n=k[1].toLowerCase()==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' '}
 return m[k.toLowerCase()]||all;
})}
function attr(tag){const obj={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))obj[m[1].toLowerCase()]=entities(m[2]??m[3]??m[4]);return obj}
const cities=['Madrid','Barcelona','Valencia','Sevilla','Zaragoza','Málaga','Murcia','Bilbao','Alicante','Oviedo','Gijón','Santander','Torrelavega','Camargo','Piélagos','Astillero','Laredo','Castro Urdiales','Burgos','Valladolid','Pamplona','León','Salamanca','Cádiz','Granada','Albacete','Vigo','Huelva','Logroño','Badajoz','Almería','Tarragona','Lleida'];
function cityFromText(text){
 const t=String(text||'');
 const known=cities.find(c=>new RegExp('(?:^|[^\\p{L}])'+c+'(?:$|[^\\p{L}])','iu').test(t));
 if(known)return known;
 const m=t.match(/(?:piso|casa|chalet|ático|apartamento|vivienda)\s+(?:en venta\s+)?en\s+([A-ZÁÉÍÓÚÑ][\p{L}\s-]{2,45}?)(?=\s*[,|·–-]|\s+con\b|\s+por\b|\s+precio\b|\.|$)/iu);
 return m&&!/^(venta|alquiler|exclusiva)$/i.test(m[1].trim())?m[1].trim():null
}
function parseTextAd(text){
 const str=entities(String(text||'').replace(/\s+/g,' ').slice(0,12000)),r=extractListing(str);
 const m=str.match(/(?:precio(?: de venta)?|venta|por)\s*[:\-]?\s*(\d{2,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d{5,8})\s*(?:€|euros?)?/i);
 const price=r.price||(m?parseMoney(m[1].replace(/\s/g,'')):null);
 return {price:price>10000?price:null,area:r.area>=15?r.area:null,city:cityFromText(str),rooms:r.rooms||null,title:null,district:null};
}
function parsePublicListingHTML(html,url){
 const meta={};for(const m of String(html||'').matchAll(/<meta\b[^>]*>/gi)){const a=attr(m[0]),k=(a.property||a.name||a.itemprop||'').toLowerCase();if(k&&a.content&&!meta[k])meta[k]=a.content}
 const titleTag=String(html||'').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'';
 const visible=String(html||'').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,14000);
 const info=parseTextAd([meta['og:title'],meta['og:description'],meta.description,titleTag,visible].filter(Boolean).join(' '));
 let selected={},score=-1;
 function scan(o,depth=0){if(!o||typeof o!=='object'||depth>8)return;if(Array.isArray(o)){o.slice(0,35).forEach(v=>scan(v,depth+1));return}
 const address=o.address||o.location?.address||{};
 const p=parseMoney(String(o.offers?.price||o.price||o.priceSpecification?.price||'')),area=Number(o.floorSize?.value||o.floorSize||o.area?.value||o.size?.value||0);
 const x={price:p>10000?p:null,area:area>=15?area:null,city:typeof address==='object'?(address.addressLocality||null):null,rooms:Number(o.numberOfBedrooms||o.numberOfRooms)||null,title:typeof o.name==='string'?o.name:null,district:null};
 const sc=(x.price?4:0)+(x.area?4:0)+(x.city?2:0)+(/apartment|house|realestate|residence|product|offer/i.test(String(o['@type']||''))?3:0);
 if(sc>score&&sc>=5){selected=x;score=sc}
 for(const [key,v] of Object.entries(o))if(v&&typeof v==='object'&&!['image','video','review','aggregateRating'].includes(key))scan(v,depth+1)
 }
 for(const m of String(html||'').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{scan(JSON.parse(m[1]))}catch{}}
 const mp=parseMoney(meta['product:price:amount']||meta['og:price:amount']||meta.price||'');
 const fields={price:selected.price|| (mp>10000?mp:null)||info.price,area:selected.area||info.area,city:selected.city||info.city,rooms:selected.rooms||info.rooms,title:selected.title||entities(meta['og:title']||titleTag).slice(0,150)||null,district:null};
 const missing=['price','area','city'].filter(k=>!fields[k]);
 return {status:missing.length?'partial':'extracted',fields,missing,url,source:'HTML público del anuncio',checkedAt:new Date().toISOString(),note:'Extracción orientativa de metadatos y texto accesible; confirma los datos con la fuente y documentación.'}
}
function publicIPv4(address){if(net.isIP(address)!==4)return false;const a=address.split('.').map(Number);return !(a[0]===0||a[0]===10||a[0]===127||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127)||(a[0]===198&&(a[1]===18||a[1]===19)))}
function publicURL(raw){
 let u;try{u=new URL(String(raw||''))}catch{throw Error('Pega un enlace válido que empiece por https://')}
 if(String(raw||'').length>1200||u.protocol!=='https:'||u.port||u.username||u.password||net.isIP(u.hostname)||!u.hostname.includes('.')||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal'))throw Error('Se requiere un enlace HTTPS público');
 return u;
}
function readPublicHTML(raw,redirects=2){
 const u=publicURL(raw);
 return new Promise((resolve,reject)=>{
  const req=https.request(u,{timeout:11000,family:4,headers:{'User-Agent':'MiInversionIA-ListingReader/1.0','Accept':'text/html,application/xhtml+xml','Accept-Encoding':'identity'},lookup:(host,opts,cb)=>dns.lookup(host,{all:true,family:4},(err,recs)=>{if(err||!recs?.length)return cb(err||Error('DNS no disponible'));if(recs.some(r=>!publicIPv4(r.address)))return cb(Error('Dirección no pública'));cb(null,recs[0].address,4)})},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){res.resume();if(!res.headers.location||!redirects)return reject(Error('Redirecciones no disponibles'));try{return readPublicHTML(new URL(res.headers.location,u).href,redirects-1).then(resolve,reject)}catch(e){return reject(e)}}
   if([401,403,429].includes(res.statusCode)){res.resume();return reject(Error('El portal limita el acceso automatizado'))}
   if(res.statusCode!==200){res.resume();return reject(Error('Anuncio no accesible: HTTP '+res.statusCode))}
   if(!/html|text\/plain/i.test(String(res.headers['content-type']||''))){res.resume();return reject(Error('Este enlace no contiene un anuncio HTML accesible'))}
   let size=0,chunks=[];res.on('data',b=>{size+=b.length;if(size>MAX_LISTING_HTML)return res.destroy(Error('Página demasiado grande'));chunks.push(b)});
   res.on('end',()=>{try{let body=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')body=zlib.gunzipSync(body);if(res.headers['content-encoding']==='br')body=zlib.brotliDecompressSync(body);if(body.length>MAX_LISTING_HTML)throw Error('Página descomprimida demasiado grande');resolve({html:body.toString('utf8'),url:u.href})}catch(e){reject(e)}});res.on('error',reject)
  });req.on('timeout',()=>req.destroy(Error('Tiempo de lectura agotado')));req.on('error',reject);req.end()
 })
}
async function importListing(payload={}){
 if(typeof payload.text==='string'&&payload.text.trim().length>55){
  const fields=parseTextAd(payload.text);fields.title=payload.text.replace(/\s+/g,' ').trim().slice(0,120);const missing=['price','area','city'].filter(k=>!fields[k]);
  return {status:missing.length?'partial':'extracted',fields,missing,source:'Texto aportado por el comprador',note:'Campos reconocidos en el texto del anuncio; revisar antes de decidir.'}
 }
 const u=publicURL(payload.url);
 try{return parsePublicListingHTML((await readPublicHTML(u.href)).html,u.href)}
 catch(e){return {status:'unavailable',url:u.href,fields:{price:null,area:null,city:null,rooms:null,title:null},missing:['price','area','city'],reason:clean(e.message,180),note:'El portal no permitió leer el anuncio. Copia el texto del anuncio completo, sin rellenar sus campos por separado.'}}
}

function mortgage(principal,annualPct,years){
  const months=Math.round(years*12);if(!(months>0 && principal>=0))return null;
  const rate=annualPct/1200;
  const monthly=rate===0?principal/months:principal*rate/(1-Math.pow(1+rate,-months));
  return {monthly:fixed(monthly),totalPaid:euro(monthly*months),totalInterest:euro(Math.max(0,monthly*months-principal)),months};
}
function median(xs){const a=[...xs].sort((a,b)=>a-b),n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null}
function evaluate(payload={}){
  const p=payload.property||{};
  const extracted=extractListing(p.listingText||'');
  const price=clamp(p.price||extracted.price,0,50e6,0);
  const area=clamp(p.area||extracted.area,0,100000,0);
  const city=clean(p.city,100);
  const desc=clean(p.listingText,3500);
  const base=area>0?price/area:null;
  const comps=(Array.isArray(payload.comparables)?payload.comparables:[]).slice(0,30)
    .map(c=>({price:clamp(c.price,0,50e6,0),area:clamp(c.area,0,100000,0),source:clean(c.source,250),city:clean(c.city,100),date:clean(c.date,32)}))
    .filter(c=>c.price>10000 && c.area>=15 && c.source && c.city && c.date && (!city||c.city.toLowerCase()===city.toLowerCase()));
  const med=comps.length>=3?median(comps.map(c=>c.price/c.area)):null;
  const fair=med&&area>0?med*area:null;
  const delta=fair>0?((price-fair)/fair)*100:null;
  const verdict=delta===null?'SIN DATOS':delta>8?'PRECIO ALTO':delta< -8?'PRECIO BAJO':'PRECIO RAZONABLE';
  const dpPct=clamp(payload.finance?.downPct,0,100,20);
  const taxPct=clamp(payload.finance?.taxPct,0,30,10);
  const fees=clamp(payload.finance?.fees,0,200000,2500);
  const apr=clamp(payload.finance?.interestPct,0,25,3.3);
  const years=clamp(payload.finance?.years,1,40,25);
  const down=price*dpPct/100;
  const financial={askPrice:euro(price),pricePerM2:base?fixed(base):null,downPayment:euro(down),
    taxesEstimated:euro(price*taxPct/100),otherFees:euro(fees),initialCash:euro(down+price*taxPct/100+fees),
    principal:euro(price-down),annualInterestPct:apr,years,taxPct,downPct:dpPct,
    mortgage:mortgage(price-down,apr,years),
    note:'Cálculo matemático orientativo. No es una oferta bancaria, tasación, fiscalidad confirmada ni aprobación.'};
  const warningSignals=[];
  const signatures=[[/humedad|humedades|filtraci[oó]n/i,'Consultar humedades y posibles filtraciones'],[/ocupad[oa]|inquilin[oa]/i,'Verificar posesión y situación de ocupación o arrendamiento'],[/carga(?:s)?|embarg[oa]|hipoteca pendiente/i,'Solicitar nota simple para confirmar cargas'],[/reforma|rehabilitar/i,'Solicitar presupuesto de obras y revisar licencias'],[/sin licencia|sin c[eé]dula/i,'Consultar situación urbanística y habitabilidad']];
  for(const [regex,message] of signatures)if(regex.test(desc))warningSignals.push(message);
  const offerList=(Array.isArray(payload.bankOffers)?payload.bankOffers:[]).slice(0,15).map(b=>({bank:clean(b.bank,80),tinPct:clamp(b.tinPct,0,30,0),years:clamp(b.years,1,40,years),fees:clamp(b.fees,0,200000,0),source:clean(b.source,250),taePct:b.taePct==null?null:clamp(b.taePct,0,40,0)})).filter(b=>b.bank&&b.source);
  const comparison=offerList.map(b=>({...b,monthly:mortgage(financial.principal,b.tinPct,b.years)?.monthly??null})).sort((a,b)=>a.monthly-b.monthly);
  const proposal=(verdict==='PRECIO ALTO'&&fair)?Math.min(price,Math.round((fair*.98)/1000)*1000):null;
  const draft=proposal
    ?`Hola. Tras revisar el inmueble anunciado por ${euro(price).toLocaleString('es-ES')} €, me gustaría presentar una propuesta inicial de ${euro(proposal).toLocaleString('es-ES')} €, sujeta a visita, revisión documental y condiciones acordadas. Quedo pendiente de vuestra respuesta.`
    :'Hola. Me interesa visitar la vivienda. Antes de presentar una oferta necesito confirmar la documentación, el estado real y varias referencias comparables. ¿Podemos coordinar una visita?';
  const findings={
    extraction:{price:extracted.price,area:extracted.area,rooms:extracted.rooms,source:'Texto del anuncio introducido por el usuario',reliability:'Pendiente de verificación manual'},
    valuation:{verdict,comparableCount:comps.length,medianPriceM2:med?fixed(med):null,estimatedFairPrice:fair?euro(fair):null,deltaPct:delta==null?null:fixed(delta),range:fair?[euro(fair*.93),euro(fair*1.07)]:null,evidence:'Comparables aportados por el usuario; no han sido contrastados con registros de compraventas.'},
    risks:warningSignals,finance:financial,negotiation:{suggestedOffer:proposal,draft,requiresApproval:true,wasSent:false},bankOffers:comparison,
    tourChecks:['Estado y humedades','Instalaciones y eficiencia energética','Ruido, entorno y orientación','ITE/IEE y documentación de comunidad','Fotos y mediciones verificadas'],
    legalChecks:['Nota simple actualizada','Titularidad y cargas','Recibos IBI y comunidad','Certificado energético','Reserva/arras revisadas por profesional','Comprobación de situación urbanística'],
    signing:['Elección libre de notario por el comprador','FEIN y documentación bancaria en plazo legal','Acta de transparencia previa cuando corresponda','Tasación aceptada y financiación aprobada','Verificación de arras, fondos y cargas','Escritura y trámites de inscripción y tributos']
  };
  const missing=[];
  if(!price)missing.push('Precio anunciado no indicado');if(!area)missing.push('Superficie no indicada');if(!city)missing.push('Municipio no indicado');
  if(comps.length<3)missing.push(`Comparables documentados insuficientes: ${comps.length}/3`);
  if(!comparison.length)missing.push('Sin ofertas bancarias reales aportadas para comparar');
  const steps=[
    ['A01',`Expediente de ${city||'ubicación pendiente'} creado para análisis sin enviar datos a terceros.`],
    ['A02',`Precio detectado en texto: ${extracted.price?euro(extracted.price).toLocaleString('es-ES')+' €':'no disponible'}. Campos pendientes de revisión.`],
    ['A03',med?`Resultado ${verdict}; ${comps.length} comparables aportados por el usuario.`:'No declara si está caro o barato: faltan tres comparables documentados.'],
    ['A04',warningSignals.length?`${warningSignals.length} señales textuales requieren comprobación.`:'No hay alertas por palabras clave; esto no certifica ausencia de riesgos.'],
    ['A05',price?`Dinero inicial estimado ${financial.initialCash.toLocaleString('es-ES')} €; cuota orientativa ${financial.mortgage.monthly.toLocaleString('es-ES')} €/mes.`:'Necesita precio y superficie para cálculos completos.'],
    ['A06',proposal?`Preparada propuesta editable de ${proposal.toLocaleString('es-ES')} € sin enviar.`:'Preparado mensaje para solicitar visita y documentación, sin enviar.'],
    ['A07',comparison.length?`${comparison.length} propuestas introducidas comparadas por cuota, sin validar condiciones.`:'Sin ofertas reales conectadas ni introducidas.'],
    ['A08','Checklist de visita listo; no hay cita real solicitada.'],
    ['A09','Lista documental creada; no sustituye la revisión jurídica.'],
    ['A10','Checklist de financiación y firma listo; no hay notaría conectada ni cita reservada.'],
    ['A11',missing.length?`Auditoría con ${missing.length} datos esenciales pendientes.`:'Datos esenciales presentes; aún se necesitan verificaciones externas.']
  ].map(([id,output])=>({id,name:AGENTS.find(a=>a.id===id).name,status:id==='A11'?'auditado':'completado',output}));
  return {runId:crypto.randomUUID(),executedAt:new Date().toISOString(),mode:'reglas_verificables_sin_llm',
    input:{price,area,city},findings,missing,steps,
    disclaimer:'No se han realizado solicitudes de hipoteca, negociaciones, reservas ni consultas restringidas a portales. Los agentes son módulos de cálculo y reglas, no once LLM autónomos.'};
}
function json(res,code,data,origin){const raw=JSON.stringify(data);res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(raw),'Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Vary':'Origin','X-Content-Type-Options':'nosniff'});res.end(raw)}
function sendFile(res,filename){fs.readFile(path.join(HERE,filename),(err,buffer)=>{if(err){res.writeHead(404);res.end('No encontrado');return;}res.writeHead(200,{'Content-Type':filename.endsWith('.html')?'text/html; charset=utf-8':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'none'"});res.end(buffer)})}
const buckets=new Map();
function throttled(req){const ip=clean(req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress,90),t=Date.now(),b=buckets.get(ip)||{reset:t+60000,count:0};if(t>b.reset){b.reset=t+60000;b.count=0}b.count++;buckets.set(ip,b);return b.count>80}
function readBody(req){return new Promise((resolve,reject)=>{let body='',done=false;req.on('data',c=>{if(done)return;body+=c;if(body.length>MAX_BODY){done=true;reject(new Error('Payload demasiado grande'));req.destroy()}});req.on('end',()=>{if(done)return;try{resolve(JSON.parse(body||'{}'))}catch{reject(new Error('JSON no válido'))}});req.on('error',reject)})}
const originOf=req=>{const o=req.headers.origin||'';return ALLOWED_ORIGINS.has(o)?o:(o?'null':'*')};
async function researchOfficial(payload){
  if(process.env.TINYFISH_ENABLED!=='true'||!process.env.TINYFISH_API_KEY)throw new Error('TinyFish no activado por el administrador');
  const target=new URL(String(payload.url||''));if(target.protocol!=='https:'||!SOURCES.some(s=>new URL(s.url).hostname===target.hostname))throw new Error('Solo se permiten fuentes oficiales autorizadas');
  const goal='Lee únicamente datos públicos de esta página oficial y devuelve un breve resumen con la URL y las limitaciones. No completes formularios ni accedas a datos privados.';
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),35000);
  try{
    const response=await fetch('https://agent.tinyfish.ai/v1/automation/run-sse',{method:'POST',headers:{'X-API-Key':process.env.TINYFISH_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({url:target.href,goal,browser_profile:'lite'}),signal:controller.signal});
    if(!response.ok)throw new Error('Error proveedor TinyFish: '+response.status);
    const raw=await response.text();let terminal=null;
    for(const line of raw.split('\n')){if(!line.startsWith('data:'))continue;try{const evt=JSON.parse(line.slice(5).trim());if(evt.type==='COMPLETE'||evt.type==='ERROR')terminal=evt}catch{}}
    if(!terminal)throw new Error('El proveedor no devolvió resultado final');
    return {url:target.href,result:terminal.resultJson??terminal.result??terminal.message??null,status:terminal.type,verifiedAt:new Date().toISOString()};
  }finally{clearTimeout(timer)}
}
async function route(req,res){
  const origin=originOf(req),u=new URL(req.url,'http://localhost'),pathname=u.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type, X-Agent-Admin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Vary':'Origin'});res.end();return;}
  if(req.method==='GET'&&(pathname==='/'||pathname==='/index.html'))return sendFile(res,'index.html');
  if(req.method==='GET'&&pathname==='/api/health')return json(res,200,{ok:true,service:'Mi Inversion IA Agentes API',now:new Date().toISOString()},origin);
  if(req.method==='GET'&&pathname==='/api/capabilities')return json(res,200,{agents:AGENTS,engines:{rules:{active:true},externalBankOffers:{active:false},notaryBooking:{active:false},propertyScraping:{active:true,mode:'HTML público sin evadir restricciones; texto pegado como respaldo'},llm:{active:false},tinyfish:{active:process.env.TINYFISH_ENABLED==='true'&&Boolean(process.env.TINYFISH_API_KEY),requiresAdmin:true}},persistence:'ninguna',security:'No envíes datos personales sensibles. Las respuestas no se almacenan.',provider:'Render'},origin);
  if(req.method==='GET'&&pathname==='/api/sources')return json(res,200,{sources:SOURCES,description:'Enlaces oficiales disponibles. No se afirma acceso a bases de datos protegidas.'},origin);
  if(throttled(req))return json(res,429,{error:'Límite temporal de peticiones. Reinténtalo más tarde.'},origin);
  if(req.method==='POST'&&pathname==='/api/import-listing'){
    try{const body=await readBody(req);return json(res,200,await importListing(body),origin)}catch(e){return json(res,400,{error:clean(e.message,220)},origin)}
  }
  if(req.method==='POST'&&pathname==='/api/analyze'){
    try{const body=await readBody(req);return json(res,200,evaluate(body),origin)}catch(e){return json(res,400,{error:e.message},origin)}
  }
  if(req.method==='POST'&&pathname==='/api/research'){
    if(!process.env.AGENT_ADMIN_TOKEN||req.headers['x-agent-admin']!==process.env.AGENT_ADMIN_TOKEN)return json(res,403,{error:'Investigación automatizada reservada al administrador; se necesita autenticación y clave de TinyFish.'},origin);
    try{const body=await readBody(req);return json(res,200,await researchOfficial(body),origin)}catch(e){return json(res,400,{error:e.message},origin)}
  }
  json(res,404,{error:'No existe ese endpoint'},origin);
}
if(require.main===module){const server=http.createServer((req,res)=>{route(req,res).catch(e=>json(res,500,{error:'Error interno de servicio'},originOf(req)))});server.listen(PORT,'0.0.0.0',()=>console.log(`Mi Inversión IA agentes escuchando en ${PORT}`));}
module.exports={evaluate,mortgage,extractListing,parseTextAd,parsePublicListingHTML,publicURL,importListing,AGENTS,SOURCES,parseMoney};