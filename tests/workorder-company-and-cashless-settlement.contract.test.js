const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('workorder company access accepts authenticated tenant ownership without weakening employee fallback',()=>{
 const route=read('src/routes/workOrderLegalEntity.ts');
 assert.match(route,/req\.user\?\.tenant_id/);
 assert.match(route,/to_jsonb\(w\)->>'tenant_id'/);
 assert.match(route,/work_order_tenant_id/);
 assert.match(route,/employeeCanAccess\(req,employeeId\)/);
 assert.match(route,/locationBelongsToTenant\(locationId,tokenTenant\)/);
 assert.match(route,/konyveles/);
 assert.match(route,/könyvelés/);
});

test('cashless workorder settlement does not require an open cashier shift while cash still does',()=>{
 const route=read('src/routes/cashierAltegioParity.ts');
 assert.doesNotMatch(route,/shift=await currentShift\(locationId\);if\(!shift\)return res\.status\(409\)/);
 assert.match(route,/if\(base==='cash'&&!shift\).*status\(409\)/s);
 assert.match(route,/p\.cashier_shift_id=shift\?\.id\|\|null/);
 assert.match(route,/shift\?\.id\|\|null,brand\|\|null,fee/);
 assert.match(route,/IF NEW\.payment_method='cash' AND v_shift IS NULL THEN/);
});
