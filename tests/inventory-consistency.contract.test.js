const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const consistency=fs.readFileSync(path.join(__dirname,'../src/routes/inventoryConsistency.ts'),'utf8');
const inventory=fs.readFileSync(path.join(__dirname,'../src/routes/inventory.ts'),'utf8');
const virP1=fs.readFileSync(path.join(__dirname,'../src/routes/virP1.ts'),'utf8');

test('consistency router is scoped to affected endpoints and runs before legacy routers',()=>{
  const consistencyAt=inventory.indexOf('const needsConsistency=');
  const lotsAt=inventory.indexOf('router.use("/ops", inventoryLotsRouter)');
  const operationsAt=inventory.indexOf('router.use("/ops", inventoryOperationsRouter)');
  assert.ok(consistencyAt>=0);
  assert.ok(lotsAt>consistencyAt);
  assert.ok(operationsAt>lotsAt);
  assert.match(inventory,/transfers\\\/\[\^\/\]\+\\\/\(dispatch\|receive\)/);
  assert.match(inventory,/stocktakes\\\/\[\^\/\]\+\\\/approve/);
  assert.match(inventory,/path==="\/reorder-suggestions"/);
  assert.doesNotMatch(inventory,/router\.use\("\/ops", inventoryConsistencyRouter\)/);
});

test('warehouse transfers use the canonical ledger and preserve LOT operation group',()=>{
  assert.match(consistency,/postWarehouseIssue/);
  assert.match(consistency,/postWarehouseReceipt/);
  assert.match(consistency,/operation_group_id/);
  assert.match(consistency,/movementType:\s*"transfer_out"/);
  assert.match(consistency,/movementType:\s*"transfer_in"/);
  assert.match(consistency,/INVENTORY_TRANSFER_LOT_LINK_MISSING/);
});

test('stocktake cannot silently corrupt a LOT-tracked balance',()=>{
  assert.match(consistency,/getProductLotTracking/);
  assert.match(consistency,/INVENTORY_LOT_STOCKTAKE_RECONCILIATION_REQUIRED/);
  assert.match(consistency,/movementType:\s*"stocktake_adjustment"/);
});

test('reorder suggestions use usable stock after expired LOT subtraction',()=>{
  assert.match(consistency,/expired_quantity/);
  assert.match(consistency,/usable_quantity/);
  assert.match(consistency,/expires_at<CURRENT_DATE/);
  assert.match(consistency,/s\.usable_quantity<=s\.min_quantity/);
});

test('VIR inventory intelligence is location-aware and FEFO usable-stock based',()=>{
  assert.match(virP1,/stock_basis:\s*"usable_non_expired_fefo"/);
  assert.match(virP1,/expired_stock_qty/);
  assert.match(virP1,/usable_stock_qty/);
  assert.match(virP1,/location_id,product_id/);
  assert.match(virP1,/consumption\.set\(`\$\{String\(r\.location_id\)\}:\$\{String\(r\.product_id\)\}`/);
});
