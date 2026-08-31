const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const transactions=fs.readFileSync(path.join(root,'src/routes/transactions.ts'),'utf8');
const recovery=fs.readFileSync(path.join(root,'src/routes/workOrderSettlementErrorRecovery.ts'),'utf8');

test('cashier and loyalty cashier chains install settlement error recovery after primary handlers',()=>{
  assert.match(transactions,/import workOrderSettlementErrorRecovery from "\.\/workOrderSettlementErrorRecovery"/);
  assert.match(transactions,/router\.use\("\/cashier",[^\n]*cashierRouter\);\s*router\.use\("\/cashier",workOrderSettlementErrorRecovery\);/);
  assert.match(transactions,/router\.use\("\/loyalty-cashier",[^\n]*loyaltyCashierRouter\);\s*router\.use\("\/loyalty-cashier",workOrderSettlementErrorRecovery\);/);
});

test('settlement error recovery only activates for financial close requests',()=>{
  assert.match(recovery,/req\.method!==\'POST\'/);
  assert.match(recovery,/!Boolean\(req\.body\?\.close_financially\)/);
  assert.match(recovery,/SETTLE_PATH/);
});

test('settlement error recovery invokes hardened retry-safe recovery service',()=>{
  assert.match(recovery,/settleWorkOrderWithoutShift\(workOrderId,req\.body,actor\(req\)\)/);
  assert.match(recovery,/auto_recovery:true/);
  assert.match(recovery,/primary_settlement_failure/);
  assert.match(recovery,/schema_drift/);
});

test('known database failures are mapped to actionable statuses instead of blind HTTP 500',()=>{
  assert.match(recovery,/code===\'22P02\'/);
  assert.match(recovery,/code===\'P0001\'/);
  assert.match(recovery,/CONSTRAINT_CODES/);
  assert.match(recovery,/code===\'57014\'\|\|code===\'55P03\'\|\|code===\'40P01\'/);
  assert.match(recovery,/CASHIER_SETTLEMENT_INVALID_ID/);
  assert.match(recovery,/CASHIER_SETTLEMENT_DATA_CONFLICT/);
  assert.match(recovery,/CASHIER_SETTLEMENT_RETRYABLE_DB/);
});

test('double failure returns structured postgres diagnostics',()=>{
  assert.match(recovery,/CASHIER_SETTLEMENT_RECOVERY_FAILED/);
  assert.match(recovery,/recovery_error:/);
  assert.match(recovery,/constraint:recoveryError\?\.constraint/);
});
