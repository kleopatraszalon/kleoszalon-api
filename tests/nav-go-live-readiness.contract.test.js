const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(process.cwd(),'src/routes/navQueueWorker.ts'),'utf8');

test('NAV go-live readiness exposes every local, NAV and deployment gate without leaking secrets',()=>{
  assert.match(source,/\/go-live-readiness/);
  assert.match(source,/ready_for_test/);
  assert.match(source,/ready_for_live/);
  assert.match(source,/supplier_tax_number/);
  assert.match(source,/technical_login/);
  assert.match(source,/technical_password/);
  assert.match(source,/xml_signing_key/);
  assert.match(source,/xml_exchange_key/);
  assert.match(source,/NAV_LIVE_SUBMIT_ENABLED/);
  assert.match(source,/live_secrets/);
  assert.match(source,/NAV TEST tokenExchange/);
  assert.match(source,/NAV TEST manageInvoice CREATE/);
  assert.match(source,/NAV TEST queryTransactionStatus DONE/);
  assert.doesNotMatch(source,/technical_password:\s*process\.env/);
  assert.doesNotMatch(source,/signing_key:\s*process\.env/);
  assert.doesNotMatch(source,/exchange_key:\s*process\.env/);
});
