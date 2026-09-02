const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('settlement recovery supports canonical and legacy payment amount columns',()=>{
  const source=read('src/services/workOrderSettlementRecovery.ts');
  assert.match(source,/\['amount','amount_huf'\]\.filter/);
  assert.match(source,/COALESCE\(amount,amount_huf\)/);
  assert.match(source,/p\?\.amount\?\?p\?\.amount_huf/);
  assert.match(source,/for\(const column of paymentAmountColumns\)/);
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
