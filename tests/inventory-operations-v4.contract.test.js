const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const route=fs.readFileSync(path.join(__dirname,'../src/routes/inventoryOperations.ts'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'../src/inventory/ensureInventoryOperationsSchema.ts'),'utf8');
const inventory=fs.readFileSync(path.join(__dirname,'../src/routes/inventory.ts'),'utf8');
const menu=fs.readFileSync(path.join(__dirname,'../src/menu/ensureInventoryOperationsMenu.ts'),'utf8');

test('v4 schema includes warehouses balances settings stocktakes transfers and sync',()=>{
  for(const name of ['inventory_warehouses','inventory_warehouse_balances','inventory_settings','inventory_units','inventory_stocktakes','inventory_stocktake_items','inventory_transfers','inventory_transfer_items'])assert.match(schema,new RegExp(name));
  assert.match(schema,/kleo_sync_legacy_balance_to_warehouse/);
  assert.match(schema,/is_default_sale/);assert.match(schema,/is_default_consumption/);
  assert.match(schema,/cost_method/);assert.match(schema,/prevent_negative_stock/);
});

test('v4 api exposes Altegio-style stock workflows',()=>{
  for(const endpoint of ['/warehouses','/settings','/units','/balances','/operations','/stocktakes','/transfers','/reorder-suggestions','/bom'])assert.ok(route.includes(`"${endpoint}`),endpoint);
  assert.match(route,/stocktake_adjustment/);assert.match(route,/transfer_out/);assert.match(route,/transfer_in/);
  assert.match(route,/weighted_average/);assert.match(route,/latest_receipt/);assert.match(route,/product_cost/);
  assert.match(route,/negative_stock_blocked/);assert.match(route,/\/stocktakes\/:id\/scan/);
});

test('legacy inventory route mounts v4 without replacing existing inventory api',()=>{
  assert.match(inventory,/inventoryOperationsRouter/);assert.match(inventory,/router\.use\("\/ops", inventoryOperationsRouter\)/);
  assert.match(inventory,/router\.get\("\/"/);assert.match(inventory,/router\.post\("\/movements"/);
});

test('inventory operations menu is permission scoped',()=>{
  assert.match(menu,/inventory\.operations/);assert.match(menu,/\/warehouse\/operations/);
  assert.match(menu,/all_locations/);assert.match(menu,/own_location/);
  assert.match(menu,/location_manager/);assert.match(menu,/receptionist/);
});
