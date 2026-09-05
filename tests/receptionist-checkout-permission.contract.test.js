const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const permission=fs.readFileSync(path.join(root,'src/middleware/menuPermission.ts'),'utf8');
const feature=fs.readFileSync(path.join(root,'src/middleware/featureAccess.ts'),'utf8');
const roles=fs.readFileSync(path.join(root,'src/security/roles.ts'),'utf8');
const pathAccess=fs.readFileSync(path.join(root,'src/middleware/pathAccess.ts'),'utf8');
const financeScope=fs.readFileSync(path.join(root,'src/middleware/workOrderFinanceScope.ts'),'utf8');
const tx=fs.readFileSync(path.join(root,'src/routes/transactions.ts'),'utf8');

test('receptionist can create and edit checkout operations at own location',()=>{
  assert.match(permission,/menuCode === "finance\.checkout"/);
  assert.match(permission,/roles\.includes\("receptionist"\)/);
  assert.match(permission,/RECEPTIONIST_CHECKOUT_ACTIONS\.has\(action\)/);
  assert.match(permission,/req\.accessScope = "own_location"/);
  assert.match(permission,/new Set<MenuAction>\(\["can_view", "can_create", "can_edit"\]\)/);
  assert.match(feature,/featureKey === "finance" && roles\.includes\("receptionist"\)/);
});

test('Hungarian, UI and numbered reception aliases normalize to receptionist',()=>{
  assert.match(roles,/receptionist: "receptionist"/);
  assert.match(roles,/reception: "receptionist"/);
  assert.match(roles,/"recepciós": "receptionist"/);
  assert.match(roles,/recepcios: "receptionist"/);
  assert.match(roles,/"recepció": "receptionist"/);
  assert.match(roles,/recepcio: "receptionist"/);
  assert.match(roles,/return "receptionist"/);
});

test('global path authorization does not let legacy RBAC rows block receptionist checkout',()=>{
  const bypass=pathAccess.indexOf('rule.menu === "finance.checkout" && roles.includes("receptionist")');
  const strictLookup=pathAccess.indexOf('strict=await isRbacFailClosed()');
  assert.ok(bypass>=0,'receptionist checkout bypass must exist');
  assert.ok(strictLookup>=0,'legacy RBAC lookup must remain for other modules');
  assert.ok(bypass<strictLookup,'receptionist checkout must be resolved before fail-closed RBAC lookup');
  assert.match(pathAccess,/return enforceLocationScope\(req,res,roles,"own_location"\)/);
});

test('workorder finance scope uses canonical roles and still enforces own salon',()=>{
  assert.match(financeScope,/parseRoleKeys\(req\.user\?\.role\)/);
  assert.match(financeScope,/const RECEPTION=new Set\(\['receptionist'\]\)/);
  assert.match(financeScope,/SCOPED\.has\(x\)/);
  assert.match(financeScope,/req\.user\?\.location_id/);
  assert.match(financeScope,/WORKORDER_FINANCE_LOCATION_REQUIRED/);
  assert.match(financeScope,/WORKORDER_FINANCE_LOCATION_MISMATCH/);
});

test('cashier settlement remains location-scoped and finance-feature protected without depending on NAV readiness',()=>{
  assert.match(tx,/router\.use\("\/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady,guardOpenCashierShift,requireFeature\("finance"\),requireMenuPermissionByMethod\("finance\.checkout"\),workOrderCashierFastRouter\)/);
  assert.match(tx,/const ensureWorkOrderFinanceReady=/);
  assert.match(tx,/ensureWorkOrderOperationalFinance\(\)/);
});

test('final workorder closing is a receptionist checkout operation and has no NAV bootstrap dependency',()=>{
  assert.match(tx,/router\.use\("\/workorder-finalization",workOrderFinanceScope,ensureWorkOrderFinanceReady,requireFeature\("finance"\),requireMenuPermissionByMethod\("finance\.checkout"\),workOrderFinalizationFastRouter\)/);
  const start=tx.indexOf('router.use("/workorder-finalization"');
  const end=tx.indexOf('router.get("/nav-online-invoice/bootstrap-status"',start);
  const finalizationMounts=tx.slice(start,end);
  assert.doesNotMatch(finalizationMounts,/ensureNavInvoiceReady/);
});