const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../src/workorders/workOrderDocument.ts'),'utf8');

test('closed workorder PDF contains official issuer identity and logo support',()=>{
  assert.match(source,/Kleopátra 2003 Szépségápoló Szolgáltató és Kereskedelmi Korlátolt Felelősségű Társaság/);
  assert.match(source,/13094445-2-41/);
  assert.match(source,/01-09-882845/);
  assert.match(source,/1132 Budapest, Visegrádi utca 8\. fszt\. 2\./);
  assert.match(source,/images\/kleo_logo\.png/);
  assert.match(source,/doc\.image\(logo/);
});

test('document remains legally distinct from an accounting invoice',()=>{
  assert.match(source,/Nem minősül adóügyi számlának/);
  assert.match(source,/NAV Online Számla adatszolgáltatásnak/);
  assert.match(source,/Számla megjelenésű archivált bizonylat/);
});

test('multi-page item tables retain identity and column headings',()=>{
  assert.match(source,/addContinuationHeader/);
  assert.match(source,/Bizonylatszám/);
  assert.match(source,/MEGNEVEZÉS/);
  assert.match(source,/KEDVEZMÉNY/);
  assert.match(source,/ÖSSZESEN/);
});
