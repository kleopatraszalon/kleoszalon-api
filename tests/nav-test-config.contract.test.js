const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const src=fs.readFileSync(path.join(process.cwd(),'src/routes/navTestUat.ts'),'utf8');
const tx=fs.readFileSync(path.join(process.cwd(),'src/routes/transactions.ts'),'utf8');

test('NAV UAT configuration write is management-only through the mounted test router',()=>{
  assert.match(tx,/router\.use\("\/nav-test-uat",requireManagement,ensureNavInvoiceReady,requireFeature\("finance"\),navTestUatRouter\)/);
  assert.match(src,/router\.put\('\/configuration'/);
});

test('NAV UAT is isolated from unrelated full finance bootstrap failures',()=>{
  assert.match(tx,/const ensureNavInvoiceReady=/);
  assert.match(tx,/router\.use\("\/nav-test-uat",requireManagement,ensureNavInvoiceReady/);
  assert.doesNotMatch(tx,/router\.use\("\/nav-test-uat",requireManagement,ensureFinanceReady/);
});

test('NAV UAT configuration can never switch to live environment',()=>{
  assert.match(src,/environment&&String\(req\.body\.environment\)\.toLowerCase\(\)!=='test'/);
  assert.match(src,/error:'nav_uat_live_blocked'/);
  assert.match(src,/environment='test'/);
  assert.doesNotMatch(src,/SET active=true,environment=\$[0-9]+/);
});

test('an existing live config is protected from test UAT overwrite',()=>{
  assert.match(src,/existing&&String\(existing\.environment\)!=='test'/);
  assert.match(src,/nav_uat_live_config_protected/);
  assert.match(src,/A teszt UAT végpont ezt nem írhatja felül/);
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

test('blank or masked secret input preserves DB secrets without copying Render ENV into DB',()=>{
  assert.match(src,/const keepSecret=/);
  assert.match(src,/masked\(next\)/);
  assert.match(src,/const effectiveTechnicalPassword=process\.env\.NAV_TECHNICAL_PASSWORD\|\|technicalPassword/);
  assert.match(src,/const effectiveSigningKey=process\.env\.NAV_SIGNING_KEY\|\|signingKey/);
  assert.match(src,/const effectiveExchangeKey=process\.env\.NAV_EXCHANGE_KEY\|\|exchangeKey/);
  assert.doesNotMatch(src,/keepSecret\([^\n]+process\.env\.NAV_/);
});

test('fixture creation requires a complete test credential set',()=>{
  assert.match(src,/if\(!safe\?\.test_ready\)return res\.status\(409\)/);
  assert.match(src,/nav_uat_credentials_missing/);
});
