const test = require('node:test');
const assert = require('node:assert/strict');
const {parseListingHTML,extractFromText,validatedListingURL,importListing}=require('./server');

test('JSON-LD apartment extracts price, metres, location, rooms, without extra fields',()=>{
  const html=`<html lang="es"><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Apartment","name":"Piso en Santander","offers":{"price":"239000"},"floorSize":{"value":83,"unitCode":"MTK"},"numberOfBedrooms":3,"address":{"addressLocality":"Santander"}}</script></head></html>`;
  const r=parseListingHTML(html,'https://example.org/piso');
  assert.deepEqual(r.missing,[]);assert.equal(r.fields.price,239000);assert.equal(r.fields.area,83);assert.equal(r.fields.city,'Santander');assert.equal(r.fields.rooms,3);
});
test('OpenGraph + description fallback reads price, area, city',()=>{
 const html=`<html><head><meta property="og:title" content="Piso en venta en Oviedo"><meta name="description" content="86 m². Precio 215.000 €"><meta property="product:price:amount" content="215000"></head></html>`;
 const r=parseListingHTML(html,'https://example.org/anuncio');assert.equal(r.fields.price,215000);assert.equal(r.fields.area,86);assert.equal(r.fields.city,'Oviedo');
});
test('One text paste replaces four manual fields',async()=>{
 const r=await importListing({text:'Piso en venta en Santander, Cantabria. 3 dormitorios, 100 m² útiles, Precio 250.000 euros. Amplia terraza y garaje.'});
 assert.equal(r.status,'extracted');assert.deepEqual(r.missing,[]);assert.equal(r.fields.price,250000);assert.equal(r.fields.area,100);assert.equal(r.fields.city,'Santander');
});
test('Missing price is NOT invented from an unrelated phrase',()=>{
 const r=extractFromText('Vivienda en Santander con terraza y garaje, superficie no indicada, contactar para precio.');
 assert.equal(r.price,null);assert.equal(r.area,null);
});
test('Private URL, HTTP, ports and credentials blocked',()=>{
 for(const url of ['http://example.org/anuncio','https://127.0.0.1/a','https://localhost/test','https://example.org:8080/a','https://u:pw@example.org/a','https://192.168.1.1/'])
   assert.throws(()=>validatedListingURL(url));
 assert.equal(validatedListingURL('https://www.example.org/vivienda/1').hostname,'www.example.org');
});
test('Unreachable property hostname is explicitly unavailable, never fictional success',async()=>{
 const r=await importListing({url:'https://example.invalid/inmueble/abc'});
 assert.equal(r.status,'unavailable');assert.equal(r.fields.price,null);assert.deepEqual(r.missing,['price','area','city']);
});
