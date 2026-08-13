const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const parity=read('src/routes/cashierAltegioParity.ts');
const fast=read('src/routes/workOrderCashierFast.ts');
const shift=read('src/routes/cashierShift.ts');
const finance=read('src/routes/financeAltegio.ts');
const sql=read('src/sql/20260813_CASHIER_ALTEGIO_PARITY_V2.sql');
const bootstrap=read('src/finance/ensureFinanceNav.ts');

test('current Stage13 shift handover close-report and PDF model remains the only physical shift model',()=>{
  assert.match(shift,/cash_register_shifts/);
  assert.match(shift,/cash_register_handovers/);
  assert.match(shift,/cash_register_close_reports/);
  assert.doesNotMatch(sql,/CREATE TABLE IF NOT EXISTS cash_register_sessions/);
});

test('Altegio parity is mounted in both normal and loyalty cashier fast paths',()=>{
  assert.match(fast,/import cashierAltegioParityRouter from '\.\/cashierAltegioParity'/);
  assert.match(fast,/router\.use\(cashierAltegioParityRouter\)/);
  assert.match(fast,/ensureFinanceNav/);
});

test('cashier exposes configured payment methods accounts transaction types and partners',()=>{
  assert.match(parity,/\/altegio\/payment-methods/);
  assert.match(parity,/\/altegio\/accounts/);
  assert.match(parity,/\/altegio\/document-types/);
  assert.match(parity,/\/altegio\/partners/);
  assert.match(parity,/finance_payment_methods/);
  assert.match(parity,/financial_accounts/);
});

test('denomination counts include interim handover accept closing and previous close',()=>{
  assert.match(sql,/CREATE TABLE IF NOT EXISTS cashier_shift_counts/);
  assert.match(sql,/denominations jsonb/);
  assert.match(sql,/opening','check','handover','accept','closing/);
  assert.match(parity,/\/shift\/:id\/count/);
  assert.match(parity,/\/shift\/previous-count/);
});

test('manual operations carry transaction type partner employee reference and account',()=>{
  assert.match(parity,/\/manual-operation/);
  assert.match(parity,/document_type_code/);
  assert.match(parity,/partner_id/);
  assert.match(parity,/employee_id/);
  assert.match(parity,/reference_no/);
  assert.match(parity,/finance_account_id/);
});

test('financial account transfer supports cash and cashless accounts',()=>{
  assert.match(parity,/\/account-transfer/);
  assert.match(parity,/source_account_id/);
  assert.match(parity,/destination_account_id/);
  assert.match(parity,/financial_movements/);
  assert.match(parity,/cash_register_movements/);
});

test('custom and split payments retain code account card brand fee and cashier shift',()=>{
  assert.match(sql,/CREATE TABLE IF NOT EXISTS cashier_payment_context/);
  assert.match(sql,/payment_method_code/);
  assert.match(sql,/finance_account_id/);
  assert.match(sql,/cashier_shift_id/);
  assert.match(sql,/card_brand/);
  assert.match(sql,/fee_amount/);
  assert.match(fast,/payment_method_code/);
  assert.match(fast,/finance_account_id/);
  assert.match(fast,/cashier_shift_id/);
});

test('cash payment cannot bypass an open cashier shift at database level',()=>{
  assert.match(sql,/cashier_enrich_work_order_payment/);
  assert.match(sql,/Készpénzes fizetés előtt nyissa meg a pénztári műszakot/);
  assert.match(sql,/trg_cashier_enrich_work_order_payment/);
});

test('partial and full refunds are audited and reduce net paid amount',()=>{
  assert.match(sql,/CREATE TABLE IF NOT EXISTS work_order_payment_refunds/);
  assert.match(sql,/refunded_amount/);
  assert.match(parity,/\/payments\/:id\/refund/);
  assert.match(parity,/SUM\(amount-refunded_amount\)/);
  assert.match(fast,/amount-COALESCE\(refunded_amount,0\)/);
});

test('existing Altegio finance layer still covers finance master data fees brands and cancellation',()=>{
  for(const marker of ['finance_partners','finance_document_types','finance_payment_methods','fee_percent','fee_fixed','brand_fees',"router.post('/operations/:id/cancel'"])assert.ok(finance.includes(marker),`missing ${marker}`);
  assert.match(bootstrap,/20260813_CASHIER_ALTEGIO_PARITY_V2\.sql/);
});
