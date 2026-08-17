const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const sql=read('src/sql/20260817_PRODUCT_STOCK_POLICY_V3.sql');
const routeSql=read('src/sql/20260817_PRODUCT_STOCK_POLICY_ROUTE_V4.sql');
const ledger=read('src/inventory/inventoryLedgerService.ts');
const inventory=read('src/routes/inventory.ts');
const override=read('src/routes/inventoryStockPolicyOverrides.ts');
const bootstrap=read('src/virSpec/ensureVirSpecModules.ts');

test('product stock policy has inherit deny allow semantics with DB guards',()=>{
  assert.match(sql,/negative_stock_policy\s+text/);
  assert.match(sql,/IN \('inherit','deny','allow'\)/);
  assert.match(sql,/kleo_product_negative_stock_allowed/);
  assert.match(sql,/trg_kleo_guard_negative_warehouse_balance/);
  assert.match(sql,/trg_kleo_guard_negative_legacy_balance/);
  assert.match(sql,/lot_tracking_enabled/);
});

test('canonical inventory ledger consults product policy for selection and issue',()=>{
  assert.match(ledger,/productNegativeStockAllowed/);
  assert.match(ledger,/const allowNegative = requiredQuantity > EPS/);
  assert.match(ledger,/if \(!allowNegative && after < -EPS\)/);
});

test('legacy inventory API and ops override honor the same product rule',()=>{
  assert.match(inventory,/productNegativeStockAllowed/);
  assert.match(inventory,/PRODUCT_NEGATIVE_STOCK_BLOCKED/);
  assert.match(inventory,/inventoryStockPolicyOverridesRouter/);
  assert.match(override,/postWarehouseIssue/);
  assert.match(override,/product_stock_policy_applied:true/);
  assert.match(override,/transfers\/:id\/dispatch/);
});

test('optimal stock target drives automatic replenishment before legacy trigger',()=>{
  assert.match(sql,/optimal_quantity/);
  assert.match(sql,/kleo_auto_replenishment_optimal_v3/);
  assert.match(sql,/trg_00_kleo_auto_replenishment_optimal_v3/);
  assert.match(sql,/THEN GREATEST\(v_opt,v_min\)/);
  assert.match(sql,/workorder_auto_optimal/);
});

test('stock policy has an audited VIR management surface on a supported generic route',()=>{
  assert.match(sql,/product-stock-policy/);
  assert.match(sql,/Termék ID \/ belső kód \/ vonalkód/);
  assert.match(sql,/Negatív készlet engedélyezve/);
  assert.match(routeSql,/\/spec\/product-stock-policy/);
  assert.match(bootstrap,/20260817_PRODUCT_STOCK_POLICY_V3\.sql/);
  assert.match(bootstrap,/20260817_PRODUCT_STOCK_POLICY_ROUTE_V4\.sql/);
});
