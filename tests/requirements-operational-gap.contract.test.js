const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=path.resolve(__dirname,'..');
const base=require(path.join(root,'docs/requirements/catalog.cjs'));
const supplement=require(path.join(root,'docs/requirements/catalog.operational.cjs'));
const inventorySupplement=require(path.join(root,'docs/requirements/catalog.operational.inventory.cjs'));
const mapping=[fs.readFileSync(path.join(root,'src/sql/20260816_UAT_KLEO_MAPPING_V3.sql'),'utf8'),fs.readFileSync(path.join(root,'src/sql/20260816_UAT_KLEO_MAPPING_V4_FEFO.sql'),'utf8')].join('\n');

test('aggregate KLEO baseline covers operational gaps',()=>{
  assert.equal(base.requirements.length,31);
  assert.equal(supplement.requirements.length,19);
  assert.equal(inventorySupplement.requirements.length,1);
  assert.equal(base.requirements.length+supplement.requirements.length+inventorySupplement.requirements.length,51);
  assert.equal([...base.requirements,...supplement.requirements,...inventorySupplement.requirements].flatMap(x=>x.acceptance_criteria).length,102);
});

test('release critical operational requirement families exist',()=>{
  const ids=new Set([...supplement.requirements,...inventorySupplement.requirements].map(x=>x.id));
  for(const id of ['KLEO-FUN-FIN-004','KLEO-FUN-PAY-001','KLEO-FUN-ACC-001','KLEO-NFR-SEC-004','KLEO-NFR-PRV-001','KLEO-NFR-BCK-001','KLEO-NFR-PERF-001','KLEO-NFR-IDEM-001','KLEO-NFR-REL-001','KLEO-FUN-INV-004'])assert.ok(ids.has(id),id);
});

test('all original UAT cases have canonical mappings',()=>{
  for(const code of ['UAT-BOOK-001','UAT-BOOK-002','UAT-WO-001','UAT-FIN-001','UAT-FIN-002','UAT-PROC-001','UAT-PROC-002','UAT-PAY-001','UAT-PAY-002','UAT-ACC-001','UAT-RBAC-001','UAT-AUDIT-001','UAT-NOTIF-001','UAT-SYS-001']){
    assert.match(mapping,new RegExp(`WHERE code='${code}'`));
  }
});

test('new release critical UAT cases are seeded',()=>{
  for(const code of ['UAT-COMM-001','UAT-GDPR-001','UAT-GDPR-002','UAT-BACKUP-001','UAT-PERF-001','UAT-IDEM-001','UAT-REL-001','UAT-INV-FEFO-001'])assert.ok(mapping.includes(`'${code}'`),code);
});
