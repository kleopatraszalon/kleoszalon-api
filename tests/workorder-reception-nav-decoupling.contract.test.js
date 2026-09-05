const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const read=p=>fs.readFileSync(p,'utf8');
const tx=read('src/routes/transactions.ts');
const operational=read('src/finance/ensureWorkOrderOperationalFinance.ts');
const legalEntity=read('src/routes/workOrderLegalEntity.ts');
const feature=read('src/middleware/featureAccess.ts');
const menu=read('src/middleware/menuPermission.ts');
const scope=read('src/middleware/workOrderFinanceScope.ts');
const lifecycle=read('src/routes/workordersLifecycleHotfix.ts');

const allMatches=(text,pattern)=>(text.match(pattern)||[]).length;

test('workorder checkout and finalization use operational finance readiness, not NAV readiness',()=>{
  assert.match(tx,/import \{ensureWorkOrderOperationalFinance\}/);
  assert.match(tx,/router\.use\("\/workorder-editor",ensureWorkOrderFinanceReady/);
  assert.ok(allMatches(tx,/router\.use\("\/cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady/g)>=6);
  assert.ok(allMatches(tx,/router\.use\("\/loyalty-cashier",workOrderFinanceScope,ensureWorkOrderFinanceReady/g)>=4);
  assert.ok(allMatches(tx,/router\.use\("\/workorder-finalization",workOrderFinanceScope,ensureWorkOrderFinanceReady/g)>=3);
  assert.match(tx,/router\.use\("\/workorder-invoice",ensureNavInvoiceReady/);
  assert.match(tx,/router\.use\("\/nav-online-invoice",ensureNavInvoiceReady/);
});

test('operational readiness only falls back to full Finance NAV bootstrap for a genuinely missing core schema',()=>{
  assert.match(operational,/let ready=await hasOperationalSchema\(\)/);
  assert.match(operational,/if\(!ready\)\{[\s\S]*await ensureFinanceNav\(\)[\s\S]*ready=await hasOperationalSchema\(\)/);
  assert.match(operational,/await ensureSalonDefaultLegalEntities\(force\)/);
  assert.match(operational,/WORKORDER_FINANCE_SCHEMA_INCOMPLETE/);
});

test('workorder company selector is operational and cannot be blocked by NAV bootstrap',()=>{
  assert.match(legalEntity,/ensureWorkOrderOperationalFinance/);
  assert.doesNotMatch(legalEntity,/ensureFinanceNav/);
  assert.ok(allMatches(legalEntity,/await ensureWorkOrderOperationalFinance\(\)/g)>=4);
});

test('receptionist is a first-class checkout operator at own location',()=>{
  assert.match(feature,/featureKey === "finance" && roles\.includes\("receptionist"\)/);
  assert.match(menu,/menuCode === "finance\.checkout"[\s\S]*roles\.includes\("receptionist"\)/);
  assert.match(scope,/const RECEPTION=new Set\(\['receptionist'/);
  assert.match(scope,/kind:'location',canEdit:true,locationId/);
  assert.match(lifecycle,/hasAnyRole\(role,\['admin','receptionist','location_manager'\]\)/);
});
