const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const ensureSrc=fs.readFileSync(path.join(process.cwd(),'src/finance/ensureFinanceNav.ts'),'utf8');
const txSrc=fs.readFileSync(path.join(process.cwd(),'src/routes/transactions.ts'),'utf8');

test('Finance NAV bootstrap errors identify the failing stage, optional substage and database code',()=>{
  assert.match(ensureSrc,/class FinanceNavBootstrapError/);
  assert.match(ensureSrc,/const substage=cause\?\.workOrderBootstrapSubstage/);
  assert.match(ensureSrc,/this\.stage=substage\?`\$\{stage\}:\$\{substage\}`:stage/);
  assert.match(ensureSrc,/this\.dbCode=cause\?\.code\?String\(cause\.code\):null/);
  assert.match(ensureSrc,/this\.constraint=cause\?\.constraint/);
  assert.match(ensureSrc,/if\(this\.constraint\)this\.stage=`\$\{this\.stage\}:\$\{this\.constraint\}`/);
  assert.match(ensureSrc,/step\('work_order_workflow'/);
  assert.match(ensureSrc,/step\('hr_v2'/);
  assert.match(ensureSrc,/step\(`sql:\$\{file\}`/);
  assert.match(ensureSrc,/step\('menu_health'/);
});

test('Finance readiness response exposes only safe bootstrap metadata in production',()=>{
  assert.match(txSrc,/bootstrap_stage:stage/);
  assert.match(txSrc,/db_code:dbCode/);
  assert.match(txSrc,/process\.env\.NODE_ENV==='development'\?String\(error\?\.message\|\|error\):undefined/);
  assert.match(txSrc,/error:'finance_schema_unavailable'/);
});
