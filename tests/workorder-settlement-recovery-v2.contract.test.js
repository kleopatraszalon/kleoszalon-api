const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('settlement recovery supports canonical and legacy payment amount columns',()=>{
  const recovery=read('src/services/workOrderSettlementRecovery.ts');
  const protectedPayment=read('src/finance/workOrderPaymentIntegrity.ts');
  assert.match(recovery,/\['amount','amount_huf'\]\.filter/);
  assert.match(recovery,/COALESCE\(amount,amount_huf\)/);
  assert.match(recovery,/p\?\.amount\?\?p\?\.amount_huf/);
  assert.match(protectedPayment,/add\('amount_huf',amount\)/);
});

test('settlement recovery stays on protected ledger path and preserves idempotency',()=>{
  const recovery=read('src/services/workOrderSettlementRecovery.ts');
  const handler=read('src/routes/workOrderSettlementErrorRecovery.ts');
  assert.match(recovery,/recordProtectedWorkOrderPayment/);
  assert.match(recovery,/protected_payment_recovery:true/);
  assert.doesNotMatch(recovery,/INSERT INTO work_order_payments\(\$\{names\.join/);
  assert.match(handler,/Idempotency-Key/);
  assert.match(handler,/workorder-settlement:/);
  assert.match(handler,/settleWorkOrderWithoutShift\(workOrderId,req\.body,actor\(req\),settlementKey\(req\)\)/);
});

test('settlement recovery preserves already-valid invoice lifecycle state',()=>{
  const source=read('src/services/workOrderSettlementRecovery.ts');
  assert.doesNotMatch(source,/add\('invoice_status'/);
  assert.match(source,/financial_closed_at=COALESCE\(financial_closed_at,now\(\)\)/);
});

test('second-stage recovery keeps cash shift business rules but does not flatten them to 500',()=>{
  const source=read('src/routes/workOrderSettlementErrorRecovery.ts');
  assert.match(source,/recoveryCode==='P0001'/);
  assert.match(source,/CASHIER_SETTLEMENT_RULE_CONFLICT/);
  assert.match(source,/CONSTRAINT_CODES\.has\(recoveryCode\)/);
  assert.match(source,/CASHIER_SETTLEMENT_RECOVERY_CONSTRAINT/);
});
