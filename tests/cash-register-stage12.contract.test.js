const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const route=read('src/routes/cashRegister.ts');
const migration=read('src/sql/20260813_CASH_REGISTER_SESSIONS_V1.sql');
const transactions=read('src/routes/transactions.ts');
const scope=read('src/middleware/workOrderFinanceScope.ts');
const bootstrap=read('src/finance/ensureFinanceNav.ts');

test('cash register schema keeps sessions and append-only cash movements',()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS cash_registers/i);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS cash_register_sessions/i);
  assert.match(migration,/UNIQUE \(location_id, business_date\)/i);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS cash_movements/i);
  assert.match(migration,/direction IN \('in','out'\)/i);
  assert.match(migration,/amount > 0/i);
});

test('cashier register lifecycle exposes open, movement, state and close operations',()=>{
  assert.match(route,/router\.get\('\/register-state'/);
  assert.match(route,/router\.post\('\/sessions\/open'/);
  assert.match(route,/router\.post\('\/cash-movements'/);
  assert.match(route,/router\.post\('\/register-daily-close'/);
  assert.match(route,/session\.status!=='open'/);
});

test('expected cash is opening plus cash sales and cash in minus cash out',()=>{
  assert.match(route,/money\(session\.opening_cash\)\+sales\.cash_sales\+mt\.cash_in-mt\.cash_out/);
  assert.match(route,/difference=money\(countedCash-expectedCash\)/);
  assert.match(route,/status='closed'/);
});

test('cash register routes are finance scoped and bootstrapped',()=>{
  assert.match(transactions,/import cashRegisterRouter from "\.\/cashRegister"/);
  assert.match(transactions,/workOrderFinanceScope,ensureFinanceReady,requireFeature\("finance"\),requireMenuPermissionByMethod\("finance\.checkout"\),cashRegisterRouter/);
  assert.match(bootstrap,/20260813_CASH_REGISTER_SESSIONS_V1\.sql/);
});

test('reception, business manager and salon manager remain allowed cashier roles',()=>{
  assert.match(scope,/receptionist/);
  assert.match(scope,/location_manager/);
  assert.match(scope,/salon_manager/);
  assert.match(scope,/szalonvezető/);
});
