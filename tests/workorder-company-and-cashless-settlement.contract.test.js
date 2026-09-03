const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('workorder company access accepts signed tenant location ownership without weakening employee fallback',()=>{
 const route=read('src/routes/workOrderLegalEntity.ts');
 assert.match(route,/req\.user\?\.tenant_id/);
 assert.match(route,/locationBelongsToTenant\(locationId,tokenTenant\)/);
 assert.match(route,/resolveTenantIdentity\(req\)/);
 assert.match(route,/employeeCanAccess\(req,employeeId\)/);
 assert.match(route,/konyveles/);
 assert.match(route,/könyvelés/);
});

test('workorder company access and chooser recognize all supported admin aliases',()=>{
 const route=read('src/routes/workOrderLegalEntity.ts');
 for(const alias of ['admin','administrator','rendszergazda','superadmin','super_admin']){
  assert.ok(route.includes(`'${alias}'`),`missing admin role alias: ${alias}`);
 }
 assert.match(route,/const canChoose=new Set\(\['admin','administrator','rendszergazda','superadmin','super_admin'/);
});

test('cashless workorder settlement does not require an open cashier shift while cash still does',()=>{
 const route=read('src/routes/cashierAltegioParity.ts');
 assert.doesNotMatch(route,/shift=await currentShift\(locationId\);if\(!shift\)return res\.status\(409\)/);
 assert.match(route,/if\(base==='cash'&&!shift\).*status\(409\)/s);
 assert.match(route,/p\.cashier_shift_id=shift\?\.id\|\|null/);
 assert.match(route,/shift\?\.id\|\|null,brand\|\|null,fee/);
 assert.match(route,/IF NEW\.payment_method='cash' AND v_shift IS NULL THEN/);
});

test('settlement recovery resolves missing legal entity before protected payment insert',()=>{
 const recovery=read('src/services/workOrderSettlementRecovery.ts');
 assert.match(recovery,/if\(woCols\.has\('legal_entity_id'\)&&!String\(wo\.legal_entity_id\|\|''\)\.trim\(\)\)/);
 assert.match(recovery,/evidence_legal_entity_ids/);
 assert.match(recovery,/WORK_ORDER_LEGAL_ENTITY_REQUIRED/);
 assert.match(recovery,/WORK_ORDER_LEGAL_ENTITY_UNAVAILABLE/);
 assert.match(recovery,/UPDATE work_orders SET legal_entity_id=\$2::uuid/);
 assert.match(recovery,/const cashierShiftId=method==='cash'\?await resolveOpenCashierShift\(c,wo,p\?\.cashier_shift_id\):null/);
});

test('settlement recovery preserves actionable application constraint messages',()=>{
 const recovery=read('src/services/workOrderSettlementRecovery.ts');
 assert.match(recovery,/readableConstraintMessage/);
 assert.match(recovery,/KLEO_CROSS_TENANT_WRITE_BLOCKED/);
 assert.match(recovery,/message:readableConstraintMessage\(error,diagnosticTarget\)/);
});
