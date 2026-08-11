const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(process.cwd(),'src/routes/navOnlineInvoiceStatus.ts'),'utf8');

test('queryTransactionStatus is pinned to the submission environment',()=>{
  assert.match(src,/const submissionEnvironment=String\(s\.environment\|\|''\)/);
  assert.ok(src.includes('base(submissionEnvironment)}/queryTransactionStatus'));
  assert.ok(!src.includes('base(c.environment)}/queryTransactionStatus'));
});

test('status refresh fails closed when active config environment changed',()=>{
  assert.match(src,/String\(c\.environment\)!==submissionEnvironment/);
  assert.match(src,/nav_environment_mismatch/);
  assert.match(src,/submission_environment:submissionEnvironment/);
  assert.match(src,/configured_environment:c\.environment/);
});
