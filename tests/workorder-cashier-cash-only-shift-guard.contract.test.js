const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

test('workorder settlement requires cashier shift only when incoming payment contains cash',()=>{
  const src=read('src/routes/transactions.ts');
  assert.match(src,/const hasCashPayment=isSettlement&&payments\.some/);
  assert.match(src,/if\(isSettlement&&!hasCashPayment\)return next\(\)/);
  assert.match(src,/normalizePaymentMethod\(p\?\.payment_method\)==='cash'/);
  assert.match(src,/cashier_shift_id:p\?\.cashier_shift_id\|\|shift\.id/);
  assert.match(src,/error_code:'CASHIER_SHIFT_REQUIRED'/);
});

test('non-cash workorder payments are not assigned a cashier shift by the route guard',()=>{
  const src=read('src/routes/transactions.ts');
  const guard=src.slice(src.indexOf('const guardOpenCashierShift='),src.indexOf('const parseRoles='));
  assert.match(guard,/if\(isSettlement&&!hasCashPayment\)return next\(\)/);
  assert.ok(!guard.includes('req.body.cashier_shift_id='),'top-level cashier shift must not leak into non-cash payment rows');
  assert.match(guard,/payments\.map\(\(p:any\)=>normalizePaymentMethod\(p\?\.payment_method\)==='cash'\?/);
});

test('database rule remains cash-specific',()=>{
  const src=read('src/routes/cashierAltegioParity.ts');
  assert.match(src,/NEW\.payment_method='cash' AND v_shift IS NULL/);
});
