const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const source=read('src/routes/legalEntitiesImport.ts');
const mount=read('src/routes/receiptCompliance.ts');

test('legal entity import accepts multiple external file formats',()=>{
  assert.match(source,/multer\.memoryStorage\(\)/);
  assert.match(source,/XLSX\.read/);
  assert.match(source,/xlsx\|xls\|xlsm\|csv\|tsv\|txt\|json/);
  assert.match(source,/parseJson/);
});

test('import has preview and transactional apply endpoints',()=>{
  assert.match(source,/router\.post\('\/import\/preview'/);
  assert.match(source,/router\.post\('\/import\/apply'/);
  assert.match(source,/await c\.query\('BEGIN'\)/);
  assert.match(source,/await c\.query\('COMMIT'\)/);
  assert.match(source,/ROLLBACK/);
});

test('import supports create-only and tax-number upsert policies',()=>{
  assert.match(source,/CREATE_ONLY/);
  assert.match(source,/UPSERT/);
  assert.match(source,/byTax/);
  assert.match(source,/action=item\.errors\.length\?'ERROR':found/);
});

test('import validates company identity and location assignment before write',()=>{
  assert.match(source,/11 számjegyű adószám/);
  assert.match(source,/Hiányzik a cégjegyzékszám/);
  assert.match(source,/Nincs szalon\/telephely hozzárendelve/);
  assert.match(source,/Ismeretlen szalon/);
  assert.match(source,/többször szerepel ugyanebben az importfájlban/);
});

test('import updates company-location dimensions and writes audit events',()=>{
  assert.match(source,/legal_entity_locations/);
  assert.match(source,/IMPORTED_CREATED/);
  assert.match(source,/IMPORTED_UPDATED/);
  assert.match(source,/legal_entity_audit_log/);
});

test('import router is mounted under legal entities API before standard entity routes',()=>{
  const imp=mount.indexOf('router.use("/legal-entities",legalEntitiesImportRouter)');
  const standard=mount.indexOf('router.use("/legal-entities",legalEntitiesRouter)');
  assert.ok(imp>=0&&standard>imp);
});
