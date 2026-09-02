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
  assert.match(recovery,/settleWorkOrderWithoutShift\(workOrderId,req\.body,actor\(req\),settlementKey\(req\)\)/);
  assert.match(recovery,/Idempotency-Key/);
  assert.match(recovery,/workorder-settlement:/);
  assert.match(recovery,/auto_recovery:true/);
  assert.match(recovery,/primary_settlement_failure/);
  assert.match(recovery,/schema_drift/);
  assert.match(recovery,/constraint_conflict/);
});

test('postgres constraint conflicts are routed through recovery instead of returning the old blocking 409',()=>{
  assert.match(recovery,/CONSTRAINT_CODES\.has\(code\)/);
  assert.doesNotMatch(recovery,/if\(CONSTRAINT_CODES\.has\(code\)\)return res\.status\(409\)/);
  assert.match(recovery,/CONSTRAINT_CODES\.has\(code\)[\s\S]*\?'constraint_conflict'/);
});

test('non-recoverable database failures are still mapped to actionable statuses',()=>{
  assert.match(recovery,/code===\'22P02\'/);
  assert.match(recovery,/code===\'P0001\'/);
  assert.match(recovery,/RETRYABLE_CODES=new Set\(\['57014','55P03','40P01'\]\)/);
  assert.match(recovery,/RETRYABLE_CODES\.has\(code\)/);
  assert.match(recovery,/CASHIER_SETTLEMENT_INVALID_ID/);
  assert.match(recovery,/CASHIER_SETTLEMENT_RULE_CONFLICT/);
  assert.match(recovery,/CASHIER_SETTLEMENT_RETRYABLE_DB/);
});

test('double failure returns structured postgres diagnostics',()=>{
  assert.match(recovery,/CASHIER_SETTLEMENT_RECOVERY_FAILED/);
  assert.match(recovery,/const recoveryDiagnostic=diagnostic\(recoveryError\)/);
  assert.match(recovery,/constraint:error\?\.constraint\?String\(error\.constraint\):null/);
  assert.match(recovery,/recovery_error:recoveryDiagnostic/);
});
