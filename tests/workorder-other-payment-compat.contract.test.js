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

test('legacy no-default not-null drift cannot block settlement recovery',()=>{
  assert.ok(compat.includes("table_name='work_order_payments'"));
  assert.ok(compat.includes("column_name NOT IN('id','work_order_id','payment_method','amount','paid_at')"));
  assert.ok(compat.includes('ALTER TABLE work_order_payments ALTER COLUMN %I DROP NOT NULL'));
  assert.ok(compat.includes("table_name='financial_accounts'"));
  assert.ok(compat.includes('ALTER TABLE financial_accounts ALTER COLUMN %I DROP NOT NULL'));
  assert.ok(compat.includes("table_name='financial_movements'"));
  assert.ok(compat.includes('ALTER TABLE financial_movements ALTER COLUMN %I DROP NOT NULL'));
});

test('canonical UUID ids and payment timestamp defaults are restored before recovery writes',()=>{
  assert.ok(compat.includes('CREATE EXTENSION IF NOT EXISTS pgcrypto'));
  assert.ok(compat.includes('ALTER TABLE work_order_payments ALTER COLUMN id SET DEFAULT gen_random_uuid()'));
  assert.ok(compat.includes('ALTER TABLE work_order_payments ALTER COLUMN paid_at SET DEFAULT now()'));
  assert.ok(compat.includes('ALTER TABLE financial_accounts ALTER COLUMN id SET DEFAULT gen_random_uuid()'));
  assert.ok(compat.includes('ALTER TABLE financial_movements ALTER COLUMN id SET DEFAULT gen_random_uuid()'));
});

test('settlement recovery runs other-payment compatibility repair before transaction',()=>{
  assert.ok(recovery.includes("import {ensureOtherPaymentCompatibility}"));
  const repair=recovery.indexOf('await ensureOtherPaymentCompatibility()');
  const connect=recovery.indexOf('const c=await db.connect()');
  assert.ok(repair>=0&&connect>repair,'compatibility repair must run before recovery transaction');
  assert.ok(recovery.includes('diagnostic.constraint'));
});
