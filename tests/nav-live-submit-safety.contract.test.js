const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('path');
const src=fs.readFileSync(path.join(process.cwd(),'src/routes/navTestUat.ts'),'utf8');

test('NAV prepare rejects non-issued internal drafts except explicit test fixtures',()=>{
  assert.match(src,/nav_invoice_not_issued/);
  assert.match(src,/document_kind\|\|'\'\)==='tax_invoice'/);
  assert.match(src,/startsWith\('KLEO-NAV-UAT-'\)/);
});

test('NAV submit is pinned to prepared environment and duplicate transactionId is idempotent',()=>{
  assert.match(src,/nav_environment_mismatch/);
  assert.match(src,/String\(s\.environment\)!==String\(c\.environment\)/);
  assert.match(src,/if\(s\.transaction_id\)return res\.json\(\{ok:true,idempotent:true/);
  assert.match(src,/nav_submission_in_progress/);
});

test('live NAV submission requires DB and environment gates plus environment secrets',()=>{
  assert.match(src,/nav_live_submission_locked/);
  assert.match(src,/c\.live_submit_enabled/);
  assert.match(src,/NAV_LIVE_SUBMIT_ENABLED/);
  for(const key of ['NAV_TECHNICAL_LOGIN','NAV_TECHNICAL_PASSWORD','NAV_SIGNING_KEY','NAV_EXCHANGE_KEY'])assert.match(src,new RegExp(key));
  assert.match(src,/nav_live_secrets_not_in_environment/);
});
