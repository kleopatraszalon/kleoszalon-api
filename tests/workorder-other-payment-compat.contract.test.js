const fs=require('node:fs');
const assert=require('node:assert/strict');
const test=require('node:test');

const compat=fs.readFileSync('src/finance/ensureOtherPaymentCompatibility.ts','utf8');
const recovery=fs.readFileSync('src/services/workOrderSettlementRecovery.ts','utf8');

test('other workorder payment repairs legacy payment and account constraints',()=>{
  for(const marker of [
    "work_order_payments_payment_method_ck",
    "payment_method IN('cash','card','transfer','voucher','other')",
    "financial_accounts_type_ck",
    "account_type IN('cash','bank','card','online','voucher','other')",
    "VALUES(NULL,'other','Egyéb','custom')",
  ])assert.ok(compat.includes(marker),marker);
});

test('settlement recovery runs other-payment compatibility repair before transaction',()=>{
  assert.ok(recovery.includes("import {ensureOtherPaymentCompatibility}"));
  const repair=recovery.indexOf('await ensureOtherPaymentCompatibility()');
  const connect=recovery.indexOf('const c=await db.connect()');
  assert.ok(repair>=0&&connect>repair,'compatibility repair must run before recovery transaction');
  assert.ok(recovery.includes('diagnostic.constraint'));
});
