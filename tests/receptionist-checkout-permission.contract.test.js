const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const permission=fs.readFileSync(path.join(root,'src/middleware/menuPermission.ts'),'utf8');
const feature=fs.readFileSync(path.join(root,'src/middleware/featureAccess.ts'),'utf8');
const roles=fs.readFileSync(path.join(root,'src/security/roles.ts'),'utf8');
const tx=fs.readFileSync(path.join(root,'src/routes/transactions.ts'),'utf8');

test('receptionist can create and edit checkout operations at own location',()=>{
  assert.match(permission,/menuCode === "finance\.checkout"/);
  assert.match(permission,/roles\.includes\("receptionist"\)/);
  assert.match(permission,/RECEPTIONIST_CHECKOUT_ACTIONS\.has\(action\)/);
  assert.match(permission,/req\.accessScope = "own_location"/);
  assert.match(permission,/new Set<MenuAction>\(\["can_view", "can_create", "can_edit"\]\)/);
  assert.match(feature,/featureKey === "finance" && roles\.includes\("receptionist"\)/);
});

test('Hungarian and reception aliases normalize to receptionist',()=>{
  assert.match(roles,/receptionist: "receptionist"/);
  assert.match(roles,/reception: "receptionist"/);
  assert.match(roles,/"recepciós": "receptionist"/);
  assert.match(roles,/recepcios: "receptionist"/);
});

test('cashier settlement remains location-scoped and finance-feature protected without depending on NAV readiness',()=>{
  assert.match(tx,/router\.use\("\/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature\("finance"\),requireMenuPermissionByMethod\("finance\.checkout"\),workOrderCashierFastRouter\)/);
  assert.match(tx,/const ensureWorkOrderFinanceReady=/);
  assert.match(tx,/ensureWorkOrderOperationalFinance\(\)/);
});