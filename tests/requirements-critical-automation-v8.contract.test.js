const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=path.resolve(__dirname,'..');
const inventory=fs.readFileSync(path.join(root,'src/routes/inventory.ts'),'utf8');

test('KLEO-FUN-INV-003-AC-01 adjustment logs reason, delta and resulting balance',()=>{
  assert.match(inventory,/movementType === \"adjustment\" && !note/);
  assert.match(inventory,/movementQuantity = requestedQuantity/);
  assert.match(inventory,/newBalance = currentBalance \+ movementQuantity/);
  assert.match(inventory,/INSERT INTO inventory_movements\(product_id,location_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by\)/);
  assert.match(inventory,/\[productId, locationId, movementType, movementQuantity, newBalance, newUnitCost, stockValueAfter, note, createdBy\]/);
});

test('KLEO-FUN-INV-003-AC-02 adjustment without reason is rejected before mutation',()=>{
  const reasonGuard=inventory.indexOf('movementType === \"adjustment\" && !note');
  const begin=inventory.indexOf('await client.query(\"BEGIN\")',reasonGuard);
  assert.ok(reasonGuard>0,'missing adjustment reason guard');
  assert.ok(begin>reasonGuard,'reason guard must execute before transaction/mutation');
  assert.match(inventory,/INVENTORY_ADJUSTMENT_REASON_REQUIRED/);
  assert.match(inventory,/res\.status\(400\)/);
});
