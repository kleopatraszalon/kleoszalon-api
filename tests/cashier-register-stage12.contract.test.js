const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const register=read('src/routes/cashierRegister.ts');
const transactions=read('src/routes/transactions.ts');

test('cashier stage12 exposes salon-scoped cash in/out movements',()=>{
  assert.match(register,/CREATE TABLE IF NOT EXISTS cash_register_movements/);
  assert.match(register,/direction IN \('in','out'\)/);
  assert.match(register,/router\.get\("\/register-movements"/);
  assert.match(register,/router\.post\("\/register-movements"/);
  assert.match(register,/router\.post\("\/register-movements\/:id\/void"/);
  assert.match(register,/A telephely kiválasztása kötelező/);
});

test('daily close includes manual register movements in expected cash',()=>{
  assert.match(register,/cash_in/);
  assert.match(register,/cash_out/);
  assert.match(register,/openingCash \+ money\(p\.cash_sales\) \+ movements\.cashIn - movements\.cashOut/);
  assert.match(register,/difference = money\(countedCash - expectedCash\)/);
});

test('closed register movements cannot be added or voided',()=>{
  assert.match(register,/if \(await isClosed\(locationId, businessDate\)\)/);
  assert.match(register,/Lezárt napi pénztár kasszamozgása nem vonható vissza/);
});

test('stage12 router runs before the existing cashier settlement routers',()=>{
  const registerMount=transactions.indexOf('cashierRegisterRouter');
  const fastMount=transactions.indexOf('workOrderCashierFastRouter',transactions.indexOf('router.use("/cashier"'));
  assert.ok(registerMount>=0);
  assert.ok(fastMount>registerMount);
});
