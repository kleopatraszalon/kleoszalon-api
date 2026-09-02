const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert');
const {test}=require('node:test');

const src=fs.readFileSync(path.join(process.cwd(),'src/services/workOrderSettlementRecovery.ts'),'utf8');

test('cash settlement recovery resolves the open cashier shift',()=>{
  assert.match(src,/resolveOpenCashierShift/);
  assert.match(src,/cash_register_shifts/);
  assert.match(src,/method==='cash'\?await resolveOpenCashierShift/);
  assert.match(src,/CASHIER_SHIFT_REQUIRED/);
});

test('known recovery database failures are returned as controlled HTTP results',()=>{
  assert.match(src,/code==='P0001'/);
  assert.match(src,/CASHIER_SETTLEMENT_RULE_CONFLICT/);
  assert.match(src,/CASHIER_SETTLEMENT_RECOVERY_CONSTRAINT/);
  assert.match(src,/CASHIER_SETTLEMENT_RETRYABLE_DB/);
});
