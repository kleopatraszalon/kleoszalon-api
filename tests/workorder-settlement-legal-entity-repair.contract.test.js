const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('settlement recovery repairs legacy workorder company dimension before payment recovery',()=>{
  const recovery=read('src/services/workOrderSettlementRecovery.ts');
  assert.match(recovery,/ensureWorkOrderSettlementCompatibility/);
  assert.ok(
    recovery.indexOf('await ensureWorkOrderSettlementCompatibility();')<recovery.indexOf('await ensureOtherPaymentCompatibility();'),
    'workorder/company compatibility must run before payment compatibility and settlement transaction',
  );
});

test('legacy workorders receive only an unambiguous active salon legal entity',()=>{
  const compat=read('src/finance/ensureWorkOrderSettlementCompatibility.ts');
  for(const marker of [
    'OLD.legal_entity_id IS NULL',
    'legal_entity_locations',
    'legal_entities',
    'el.is_default=true',
    'active_count=1',
    'UPDATE work_orders SET legal_entity_id=resolved_id',
    'financial_closed_at IS NULL',
  ]) assert.ok(compat.includes(marker),`missing compatibility marker: ${marker}`);

  assert.match(compat,/több aktív cég tartozik/);
  assert.match(compat,/meglévő fizetése más kibocsátó céghez tartozik/);
  assert.match(compat,/meglévő számlája más kibocsátó céghez tartozik/);
});

test('financial evidence triggers resolve the workorder company instead of failing immediately on legacy null',()=>{
  const compat=read('src/finance/ensureWorkOrderSettlementCompatibility.ts');
  assert.match(compat,/CREATE OR REPLACE FUNCTION vir_fill_legal_entity/);
  assert.match(compat,/SELECT w\.legal_entity_id,w\.location_id::text/);
  assert.match(compat,/NEW\.legal_entity_id:=resolved_id/);
  assert.match(compat,/A munkalap szalonjához nincs aktív kibocsátó cég rendelve/);
});
