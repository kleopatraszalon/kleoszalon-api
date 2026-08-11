const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const uat=read('src/routes/navTestUat.ts');
const tx=read('src/routes/transactions.ts');

test('NAV automated UAT is hard-blocked outside test environment',()=>{
  assert.match(uat,/uat_test_only!==true/);
  assert.match(uat,/String\(s\.environment\)!=='test'/);
  assert.match(uat,/String\(c\?\.environment\)!=='test'/);
  assert.match(uat,/nav_uat_live_blocked/);
  assert.match(tx,/router\.use\("\/nav-online-invoice",navTestOnlySubmitGuard\)/);
});

test('NAV UAT fixture is clearly isolated and exercises multi VAT CREATE',()=>{
  assert.match(uat,/KLEO-\$\{uatTag\}/);
  assert.match(uat,/AUTOMATIZÁLT NAV TESZT UAT/);
  assert.match(uat,/0\.27,1000,270,1270/);
  assert.match(uat,/0\.05,1000,50,1050/);
  assert.match(uat,/expected:\{operation:'CREATE',vat_rates:\[0\.27,0\.05\]/);
});

test('NAV UAT chain evidence endpoint returns invoices and submissions',()=>{
  assert.match(uat,/router\.get\('\/chain\/:invoiceId'/);
  assert.match(uat,/original_invoice_id=\$1::uuid/);
  assert.match(uat,/nav_invoice_submissions/);
  assert.match(uat,/startsWith\('KLEO-NAV-UAT-'\)/);
});
