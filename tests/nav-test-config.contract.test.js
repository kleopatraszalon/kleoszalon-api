const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const src=fs.readFileSync(path.join(process.cwd(),'src/routes/navTestUat.ts'),'utf8');
const tx=fs.readFileSync(path.join(process.cwd(),'src/routes/transactions.ts'),'utf8');

test('NAV UAT configuration write is management-only through the mounted test router',()=>{
  assert.match(tx,/router\.use\("\/nav-test-uat",requireManagement,ensureFinanceReady,requireFeature\("finance"\),navTestUatRouter\)/);
  assert.match(src,/router\.put\('\/configuration'/);
});

test('NAV UAT configuration can never switch to live environment',()=>{
  assert.match(src,/environment&&String\(req\.body\.environment\)\.toLowerCase\(\)!=='test'/);
  assert.match(src,/error:'nav_uat_live_blocked'/);
  assert.match(src,/environment='test'/);
  assert.doesNotMatch(src,/SET active=true,environment=\$[0-9]+/);
});

test('NAV UAT configuration never echoes stored secrets and reports only presence',()=>{
  assert.match(src,/technical_password_configured:Boolean/);
  assert.match(src,/signing_key_configured:Boolean/);
  assert.match(src,/exchange_key_configured:Boolean/);
  assert.match(src,/credential_source/);
  assert.doesNotMatch(src,/technical_password:row\.technical_password/);
  assert.doesNotMatch(src,/signing_key:row\.signing_key/);
  assert.doesNotMatch(src,/exchange_key:row\.exchange_key/);
});

test('blank or masked secret input preserves existing or environment-backed credentials',()=>{
  assert.match(src,/const keepSecret=/);
  assert.match(src,/masked\(next\)/);
  assert.match(src,/process\.env\.NAV_TECHNICAL_PASSWORD/);
  assert.match(src,/process\.env\.NAV_SIGNING_KEY/);
  assert.match(src,/process\.env\.NAV_EXCHANGE_KEY/);
});

test('fixture creation requires a complete test credential set',()=>{
  assert.match(src,/if\(!safe\?\.test_ready\)return res\.status\(409\)/);
  assert.match(src,/nav_uat_credentials_missing/);
});
