const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const shift=read('src/routes/cashierShift.ts');
const pdf=read('src/services/cashierClosePdf.ts');
const tx=read('src/routes/transactions.ts');
const scope=read('src/middleware/workOrderFinanceScope.ts');

test('stage13 models shift open handover acceptance and immutable close report',()=>{
  assert.match(shift,/CREATE TABLE IF NOT EXISTS cash_register_shifts/);
  assert.match(shift,/CREATE TABLE IF NOT EXISTS cash_register_handovers/);
  assert.match(shift,/CREATE TABLE IF NOT EXISTS cash_register_close_reports/);
  assert.match(shift,/router\.post\('\/shift\/open'/);
  assert.match(shift,/router\.post\('\/shift\/:id\/handover'/);
  assert.match(shift,/handovers\/:handoverId\/accept/);
  assert.match(shift,/router\.post\('\/shift\/:id\/close'/);
  assert.match(shift,/snapshot jsonb/);
});

test('shift close uses opening cash sales and manual register movements',()=>{
  assert.match(shift,/opening_cash/);
  assert.match(shift,/cash_sales/);
  assert.match(shift,/cash_in/);
  assert.match(shift,/cash_out/);
  assert.match(shift,/totals\.cash_sales \+ totals\.cash_in - totals\.cash_out/);
  assert.match(shift,/countedCash - totals\.expected_cash/);
});

test('stage13 provides printable source history and PDF routes',()=>{
  assert.match(shift,/router\.get\('\/shift-history'/);
  assert.match(shift,/router\.get\('\/shift-reports\/:id'/);
  assert.match(shift,/router\.get\('\/shift-reports\/:id\/pdf'/);
  assert.match(pdf,/PÉNZTÁRZÁRÁSI JEGYZŐKÖNYV/);
  assert.match(pdf,/generateCashierClosePdf/);
});

test('cashier shift router is mounted before legacy cashier routers',()=>{
  const shiftMount=tx.indexOf('cashierShiftRouter');
  const registerMount=tx.indexOf('cashierRegisterRouter',tx.indexOf('router.use("/cashier"'));
  assert.ok(shiftMount>=0);
  assert.ok(registerMount>shiftMount);
});

test('payments and manual register movements require an open shift server-side',()=>{
  assert.match(tx,/guardOpenCashierShift/);
  assert.match(tx,/register-movements/);
  assert.match(tx,/cash_register_shifts/);
  assert.match(tx,/status='open'/);
  assert.match(tx,/Függő átadás-átvétel/);
});

test('cashier history is server-side manager only',()=>{
  assert.match(tx,/guardCashierHistoryRole/);
  assert.match(tx,/shift-history/);
  assert.match(tx,/A vezetői kasszatörténet csak adminisztrátor/);
});

test('salon managers are part of scoped cashier finance access and admin workorder location is inferred',()=>{
  assert.match(scope,/salon_manager/);
  assert.match(scope,/szalonvezető/);
  assert.match(scope,/workOrderFinanceLocationId/);
  assert.match(scope,/SELECT location_id FROM work_orders/);
});
