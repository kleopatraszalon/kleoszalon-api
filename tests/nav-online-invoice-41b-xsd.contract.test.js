const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const prepare=read('scripts/prepare-nav-xsd-assets.mjs');
const validator=read('src/nav/navXsdValidator.ts');
const route=read('src/routes/navOnlineInvoice.ts');
const migration=read('src/sql/20260811_NAV_ONLINE_INVOICE_41B_XSD.sql');
const bootstrap=read('src/finance/ensureFinanceNav.ts');
const pkg=JSON.parse(read('package.json'));

test('NAV XSD assets are pinned to exact official revisions and verified',()=>{
  assert.match(prepare,/cc7a775d6dce361311e409abb9934eb755f2749c/);
  assert.match(prepare,/1f37f991fd9fb606b29aac9d8e367d52616e3d69/);
  assert.match(prepare,/c644a7112e02e4be53ec151feb00c472ef1c769f/);
  assert.match(prepare,/f3484ffe0ad8a85104fc77bacde669eaf47248bb/);
  assert.match(prepare,/ece06647ae0d454353f347e3d5d4ae9fb96a27f4/);
  assert.match(prepare,/sha512-GVMuR3ViU8R7sakcVm\/4GClMtCV8p7xgjXZlc6GmvPpInIz4V41lmRnjSd4uKhVkf5MZj97wEZkPM4RMAhojuQ==/);
  assert.match(prepare,/runtimeNetworkRequired:false/);
});

test('runtime validator uses local XSD and WASM assets only',()=>{
  assert.match(validator,/path\.join\(__dirname,'xsd'\)/);
  assert.match(validator,/path\.join\(__dirname,'vendor','xmllint-wasm'\)/);
  assert.match(validator,/fileName:'invoiceData\.xsd'/);
  assert.match(validator,/fileName:'invoiceBase\.xsd'/);
  assert.match(validator,/fileName:'common\.xsd'/);
  assert.doesNotMatch(validator,/axios|https?:\/\/|fetch\(/);
});

test('prepare and submit both enforce XSD validation fail-closed',()=>{
  const prepareStart=route.indexOf("router.post('/invoices/:id/prepare'");
  const submitStart=route.indexOf("router.post('/submissions/:id/submit'");
  assert.ok(prepareStart>=0&&submitStart>prepareStart);
  const prepareBody=route.slice(prepareStart,submitStart);
  const submitBody=route.slice(submitStart);
  assert.ok(prepareBody.indexOf('validateNavInvoiceXmlXsd(xml)')>=0);
  assert.ok(prepareBody.indexOf('validateNavInvoiceXmlXsd(xml)')<prepareBody.indexOf('INSERT INTO nav_invoice_submissions'));
  assert.ok(submitBody.indexOf('validateNavInvoiceXmlXsd(String(s.invoice_xml))')>=0);
  assert.ok(submitBody.indexOf('validateNavInvoiceXmlXsd(String(s.invoice_xml))')<submitBody.indexOf('exchangeToken(c)'));
  assert.match(submitBody,/NAV felé nem történt hálózati beküldés/);
});

test('XSD runtime status and explicit invoice validation endpoints exist',()=>{
  assert.match(route,/router\.get\('\/xsd-status'/);
  assert.match(route,/router\.post\('\/invoices\/:id\/xsd-validate'/);
  assert.match(route,/fail_closed:true/);
});

test('XSD validation is auditable and bootstrapped',()=>{
  assert.match(migration,/nav_invoice_xsd_validation_runs/);
  assert.match(migration,/nav_xsd_validation_status/);
  assert.match(migration,/xsd_validation_status/);
  assert.match(migration,/xml_sha256/);
  assert.match(migration,/schema_revision/);
  assert.match(bootstrap,/20260811_NAV_ONLINE_INVOICE_41B_XSD\.sql/);
});

test('production build runs pinned asset preparation and real XSD smoke test',()=>{
  assert.match(pkg.scripts.build,/prepare-nav-xsd-assets\.mjs/);
  assert.match(pkg.scripts.build,/copy-nav-build-assets\.mjs/);
  assert.match(pkg.scripts.build,/nav-xsd-smoke\.cjs/);
});
