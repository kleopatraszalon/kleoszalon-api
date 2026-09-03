const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('every salon can receive its own non-fake fallback legal entity without overriding a real default',()=>{
  const src=read('src/finance/ensureSalonDefaultLegalEntities.ts');
  assert.match(src,/AUTO-LOCATION-/);
  assert.match(src,/INTERNAL_PLACEHOLDER/);
  assert.match(src,/registered_country_code/);
  assert.match(src,/'XX'/);
  assert.match(src,/system-default-salon-company/);
  assert.match(src,/NOT EXISTS\([\s\S]*existing\.is_default=true/);
  assert.match(src,/ON CONFLICT\(legal_entity_id,location_id\)/);
});

test('settlement recovery seeds salon defaults before retrying protected payment',()=>{
  const route=read('src/routes/workOrderSettlementErrorRecovery.ts');
  assert.match(route,/ensureSalonDefaultLegalEntities/);
  assert.ok(route.indexOf('await ensureSalonDefaultLegalEntities()')<route.indexOf('settleWorkOrderWithoutShift('));
});
