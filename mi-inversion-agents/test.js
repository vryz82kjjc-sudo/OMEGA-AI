const test=require('node:test');const assert=require('node:assert/strict');const {evaluate,mortgage,extractListing,AGENTS,parseMoney}=require('./server.js');
test('11 agentes existentes',()=>assert.equal(AGENTS.length,11));
test('cuota 160000 al 3% 25 años ~759',()=>assert.ok(Math.abs(mortgage(160000,3,25).monthly-758.74)<.2));
test('sistema no inventa valor sin 3 comparables',()=>{const r=evaluate({property:{price:200000,area:100,city:'Santander'}});assert.equal(r.findings.valuation.verdict,'SIN DATOS');assert.equal(r.steps.length,11)});
test('3 comparables aportados permiten evaluar',()=>{const r=evaluate({property:{price:300000,area:100,city:'Santander'},comparables:[1,2,3].map(i=>({price:200000,area:100,city:'Santander',source:'fuente '+i,date:'2026-11-01'}))});assert.equal(r.findings.valuation.verdict,'PRECIO ALTO');assert.ok(r.findings.negotiation.suggestedOffer<300000)});
test('no falsea ofertas bancarias',()=>{const r=evaluate({property:{price:200000,area:100,city:'Santander'}});assert.equal(r.findings.bankOffers.length,0)});
test('reconoce texto y fuente manual',()=>{const x=extractListing('Piso de 100 m² y 3 habitaciones. Precio 220.000 €');assert.equal(x.price,220000);assert.equal(x.area,100);assert.equal(x.rooms,3)});
test('amortización a interés cero',()=>assert.equal(mortgage(120000,0,10).monthly,1000));
test('parseMoney diversos formatos',()=>{assert.equal(parseMoney('200.000'),200000);assert.equal(parseMoney('239.000,00'),239000)});