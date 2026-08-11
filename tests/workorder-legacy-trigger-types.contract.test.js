const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const repair=read('src/workorders/repairLegacyWorkOrderTriggers.ts');
const booking=read('src/booking/repairBookingWorkOrderStatusConstraints.ts');
const finalization=read('src/routes/workOrderFinalizationRecovery.ts');

test('legacy workorder triggers compare mixed identifier types through text',()=>{
  assert.match(repair,/i\.work_order_id::text=NEW\.id::text/);
  assert.match(repair,/p\.work_order_id::text=NEW\.id::text/);
  assert.match(repair,/id::text=OLD\.work_order_id::text/);
  assert.match(repair,/DECLARE wid text/);
  assert.match(repair,/WHERE id::text=wid/);
});

test('trigger repair runs before both arrival and document recovery operations',()=>{
  assert.match(booking,/await repairLegacyWorkOrderTriggers\(c\)/);
  assert.match(finalization,/await repairLegacyWorkOrderTriggers\(c\)/);
});
