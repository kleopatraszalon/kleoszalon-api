const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const recovery=fs.readFileSync(path.join(root,'src/services/workOrderSettlementRecovery.ts'),'utf8');

test('settlement recovery tolerates partially migrated work order schemas',()=>{
  assert.match(recovery,/columnTypes\(c,'work_orders'\)/);
  assert.match(recovery,/woCols\.has\('fully_paid'\)/);
  assert.match(recovery,/woCols\.has\('financial_closed_by'\).*textLike/);
  assert.match(recovery,/timestampLike\(woTypes\.get\('updated_at'\)\)/);
  assert.doesNotMatch(recovery,/UPDATE work_orders SET gross_total=\$2,discount_amount=\$3/);
});

test('settlement recovery fails explicitly instead of HTTP 500 on missing required schema',()=>{
  assert.match(recovery,/WORK_ORDER_SCHEMA_INCOMPLETE/);
  assert.match(recovery,/WORK_ORDER_PAYMENT_SCHEMA_INCOMPLETE/);
});

test('settlement recovery is retry safe for already recorded payments',()=>{
  assert.match(recovery,/existingPaid/);
  assert.match(recovery,/remaining=Math\.max\(0,money\(due-existingPaid\)\)/);
  assert.match(recovery,/if\(remaining<=\.009\)break/);
  assert.match(recovery,/Math\.min\(requestedAmount,remaining\)/);
});

test('settlement recovery logs postgres diagnostics for production failures',()=>{
  assert.match(recovery,/\[workorder-settlement-recovery\] failed/);
  assert.match(recovery,/error\?\.constraint/);
});
