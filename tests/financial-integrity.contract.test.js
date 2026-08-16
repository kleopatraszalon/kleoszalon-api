const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sql=read('src/sql/20260816_FINANCIAL_INTEGRITY_V1.sql');
const service=read('src/finance/financialIntegrity.ts');
const v5=read('src/routes/financeAltegioV5.ts');
const legacy=read('src/routes/financeAltegio.ts');
const cashier=read('src/routes/cashierAltegioParity.ts');
const register=read('src/routes/cashierRegister.ts');
const financeOperations=read('src/routes/financeOperations.ts');
const workOrderPayments=read('src/finance/workOrderPaymentIntegrity.ts');
const workOrderCashier=read('src/routes/workOrderCashierFast.ts');
const loyaltyCashier=read('src/routes/loyaltyCashier.ts');
const workOrderEditor=read('src/routes/workOrderEditor.ts');
const bootstrap=read('src/finance/ensureFinanceNav.ts');

test('10/10 financial integrity: ledger is append-only and exact reversal is unique',()=>{
  assert.match(sql,/ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'posted'/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS cancellation_reason text/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS reversed_by_id uuid/);
  assert.match(sql,/A pénzügyi főkönyvből fizikai törlés nem engedélyezett/);
  assert.match(sql,/A könyvelt pénzügyi tétel tartalma nem módosítható/);
  assert.match(sql,/financial_movements_one_reversal_uq/);
  assert.match(sql,/A sztornó nem az eredeti tétel pontos, ellenkező irányú párja/);
  assert.match(service,/reverseFinancialMovement/);
  assert.match(service,/reversal_of_id/);
});

test('10/10 financial integrity: posting, transfer and refund are atomic',()=>{
  for(const source of [v5,legacy,cashier,register]){
    assert.match(source,/BEGIN/);
    assert.match(source,/COMMIT/);
    assert.match(source,/ROLLBACK/);
  }
  assert.match(sql,/trg_finance_assert_transfer_balanced/);
  assert.match(sql,/Az átvezetés két könyvelési lába hiányzik vagy nem egyezik/);
  assert.doesNotMatch(cashier,/financial_movements[\s\S]{0,500}catch\(\(\)=>undefined\)/);
  assert.match(cashier,/financial_movement_id/);
  assert.match(sql,/trg_finance_work_order_payment_ledger/);
  assert.match(workOrderPayments,/recordProtectedWorkOrderPayment/);
  assert.match(workOrderCashier,/recordProtectedWorkOrderPayment/);
  assert.match(loyaltyCashier,/recordProtectedWorkOrderPayment/);
  assert.match(workOrderEditor,/recordProtectedWorkOrderPayment/);
});

test('10/10 financial integrity: period locks, negative-balance and idempotency fail closed',()=>{
 assert.match(sql,/ALTER TABLE financial_accounts[\s\S]*allow_negative_balance/);
 assert.match(sql,/CREATE TABLE IF NOT EXISTS financial_transfers/);
 assert.match(sql,/CREATE TABLE IF NOT EXISTS accounting_journal_entries/);
 assert.match(sql,/CREATE TABLE IF NOT EXISTS finance_period_locks/);
  assert.match(sql,/A pénzügyi időszak lezárt/);
  assert.match(sql,/allow_negative_balance/);
  assert.match(sql,/egyenlege negatívvá válna/);
  assert.match(sql,/financial_movements_idempotency_uq/);
  assert.match(service,/requireIdempotencyKey/);
  for(const source of [v5,cashier,register,financeOperations,workOrderCashier,loyaltyCashier,workOrderEditor])assert.match(source,/requireIdempotencyKey/);
});

test('10/10 financial integrity: prepaid value is never recognized twice',()=>{
  assert.match(sql,/voucher_redemption/);
  assert.match(sql,/prepaid_redemption/);
  assert.match(sql,/Az utalványbeváltás nem könyvelhető új bevételként/);
  assert.match(workOrderPayments,/recognition!==\'ledger_income\'/);
  assert.match(loyaltyCashier,/recognition:\'voucher_redemption\'/);
  assert.match(loyaltyCashier,/recognition:\'prepaid_redemption\'/);
});

test('10/10 financial integrity: journals balance and evidence cannot be erased',()=>{
  assert.match(sql,/trg_finance_journal_lines_balanced/);
  assert.match(sql,/tartozik <> követel/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS finance_integrity_events/);
  assert.match(sql,/trg_finance_integrity_events_immutable/);
  assert.match(v5,/integrity\/reconciliation/);
  assert.match(v5,/integrity\/period-locks/);
});

test('financial integrity migration is a mandatory Finance bootstrap stage',()=>{
  assert.match(bootstrap,/20260816_FINANCIAL_INTEGRITY_V1\.sql/);
});
