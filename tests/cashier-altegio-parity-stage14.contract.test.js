const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('src/routes/cashierAltegioParity.ts');
const tx=read('src/routes/transactions.ts');
const fast=read('src/routes/workOrderCashierFast.ts');
const sql=read('src/sql/20260813_CASHIER_ALTEGIO_PARITY_V1.sql');
const shift=read('src/routes/cashierShift.ts');
const finance=read('src/routes/financeAltegio.ts');

test('current main cashier shift remains the single physical shift lifecycle',()=>{
 assert.match(shift,/cash_register_shifts/);
 assert.match(shift,/cash_register_handovers/);
 assert.match(shift,/cash_register_close_reports/);
 assert.doesNotMatch(sql,/CREATE TABLE IF NOT EXISTS cash_register_sessions/);
});

test('Altegio financial accounts and payment methods are exposed to cashier',()=>{
 assert.match(route,/\/altegio\/payment-methods/);
 assert.match(route,/\/altegio\/accounts/);
 assert.match(route,/finance_payment_methods/);
 assert.match(route,/financial_accounts/);
 assert.match(sql,/allow_cashless/);
 assert.match(sql,/fee_percent/);
 assert.match(sql,/brand_fees/);
});

test('cashier supports denominations and prior shift checks without replacing handover',()=>{
 assert.match(sql,/CREATE TABLE IF NOT EXISTS cashier_shift_counts/);
 assert.match(sql,/denominations jsonb/);
 assert.match(route,/\/shift\/:id\/count/);
 assert.match(route,/\/shift\/previous-count/);
 assert.match(route,/count_type/);
 assert.match(route,/handover/);
 assert.match(route,/closing/);
});

test('manual operations include category partner employee and reference data',()=>{
 assert.match(route,/\/manual-operation/);
 assert.match(route,/document_type_code/);
 assert.match(route,/partner_id/);
 assert.match(route,/employee_id/);
 assert.match(route,/reference_no/);
 assert.match(route,/finance_account_id/);
});

test('account transfers cover cash and cashless financial accounts',()=>{
 assert.match(route,/\/account-transfer/);
 assert.match(route,/source_account_id/);
 assert.match(route,/destination_account_id/);
 assert.match(route,/financial_movements/);
 assert.match(route,/cash_register_movements/);
});

test('checkout keeps split tender while storing custom method account card brand and fee',()=>{
 assert.ok(tx.indexOf('cashierAltegioParityRouter')<tx.indexOf('workOrderCashierFastRouter'));
 assert.match(route,/payment_method_code/);
 assert.match(route,/card_brand/);
 assert.match(route,/fee_amount/);
 assert.match(route,/cashier_payment_context/);
 assert.match(fast,/finance_account_id/);
 assert.match(fast,/cashier_shift_id/);
});

test('cash payment is protected at route and database levels',()=>{
 assert.match(tx,/guardOpenCashierShift/);
 assert.match(sql,/cashier_enrich_work_order_payment/);
 assert.match(sql,/Készpénzes fizetés előtt nyissa meg a pénztári műszakot/);
});

test('partial and full refunds are auditable and reduce net paid total',()=>{
 assert.match(sql,/CREATE TABLE IF NOT EXISTS work_order_payment_refunds/);
 assert.match(sql,/refunded_amount/);
 assert.match(route,/\/payments\/:id\/refund/);
 assert.match(route,/SUM\(amount-refunded_amount\)/);
 assert.match(fast,/amount-COALESCE\(refunded_amount,0\)/);
});

test('cash drawer expected total does not double subtract cash refunds',()=>{
 assert.match(route,/SUM\(wp\.amount\) FILTER\(WHERE wp\.payment_method='cash'\)/);
 assert.doesNotMatch(route,/SUM\(wp\.amount-COALESCE\(wp\.refunded_amount,0\)\) FILTER\(WHERE wp\.payment_method='cash'\)/);
 assert.match(route,/reason_code[^\n]*refund|refund/);
});

test('existing Altegio finance category partner cancellation and fee model remains intact',()=>{
 for(const marker of ['finance_partners','finance_document_types','finance_payment_methods','fee_percent','fee_fixed','brand_fees',"router.post('/operations/:id/cancel'"])assert.ok(finance.includes(marker),`missing ${marker}`);
});
