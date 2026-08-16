'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-INV-001-AC-01
// KLEO-FUN-INV-001-AC-02
test('warehouse transfer is transactional, paired by one movement id, and blocks negative source stock',()=>{
  const src=read('src/routes/inventoryOperations.ts');
  assert.match(src,/const group = randomUUID\(\)/);
  assert.match(src,/movementType: "transfer_out"/);
  assert.match(src,/movementType: "transfer_in"/);
  assert.match(src,/operationGroupId: group/);
  assert.match(src,/destinationWarehouseId/);
  assert.match(src,/prevent_negative_stock && after < -EPS/);
  assert.match(src,/transfer_insufficient_stock/);
  assert.match(src,/client\.query\("BEGIN"\)/);
  assert.match(src,/client\.query\("COMMIT"\)/);
  assert.match(src,/client\.query\("ROLLBACK"\)/);
});
