const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('legacy admin routers are protected at server mount',()=>{
  const src=read('src/server.ts');
  assert.match(src,/\/api\/admin\/webshop[^\n]*requireManagement/);
  assert.match(src,/\/api\/admin\/signage[^\n]*requireManagement/);
  assert.match(src,/\/api\/admin\/signage-appearance[^\n]*requireManagement/);
});

test('menu and feature guards support fail-closed mode',()=>{
  const menu=read('src/middleware/menuPermission.ts');
  const feature=read('src/middleware/featureAccess.ts');
  assert.match(menu,/isRbacFailClosed/);
  assert.match(menu,/permission_not_configured/);
  assert.match(menu,/menu_not_configured/);
  assert.match(feature,/isRbacFailClosed/);
  assert.match(feature,/feature_not_configured/);
  assert.match(menu,/rbac_schema_unavailable/);
  assert.match(feature,/rbac_schema_unavailable/);
});

test('RBAC migration activates strict mode only after explicit matrix',()=>{
  const sql=read('src/sql/20260810_RBAC_FAIL_CLOSED_V1.sql');
  const marker="20260810_RBAC_FAIL_CLOSED_V1";
  const markerPos=sql.lastIndexOf(marker);
  const denyPos=sql.indexOf('explicit DENY');
  const checkoutPos=sql.indexOf("m.code='finance.checkout'");
  assert.ok(denyPos>=0 && checkoutPos>=0 && markerPos>checkoutPos,'marker must be written after matrix grants');
  for(const role of ['admin','manager','location_manager','salon_manager','receptionist','employee','customer']){
    assert.match(sql,new RegExp(`'${role}'`));
  }
});

test('work-order and checkout invariants match business rules',()=>{
  const sql=read('src/sql/20260810_RBAC_FAIL_CLOSED_V1.sql');
  assert.match(sql,/Munkalap szerkesztés csak admin, recepció, üzletvezető/);
  assert.match(sql,/p\.role_key IN \('manager','salon_manager','employee','customer'\)/);
  assert.match(sql,/p\.role_key IN \('location_manager','receptionist'\)/);
  assert.match(sql,/p\.role_key IN \('salon_manager','employee','customer'\)/);
});

test('capability metadata defaults missing permissions to deny',()=>{
  const src=read('src/routes/accessControl.ts');
  assert.match(src,/configured:false,can_view:false,can_create:false,can_edit:false,can_delete:false/);
  assert.doesNotMatch(src,/configured:false,can_view:true,can_create:true,can_edit:true/);
});
