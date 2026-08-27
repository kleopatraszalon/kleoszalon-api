const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const external=read('src/routes/externalFinancialDocuments.ts');
const settings=read('src/routes/externalFinancialDocumentSettingsOverride.ts');
const receiptRouter=read('src/routes/receiptCompliance.ts');
const nav=read('src/routes/receiptDocumentsCompliance.ts');

test('external document intake is mounted inside receipt compliance',()=>{
  assert.match(receiptRouter,/externalFinancialDocumentsRouter/);
  assert.match(receiptRouter,/router\.use\("\/external-documents"/);
});

test('external documents are separate from immutable VIR receipt documents and default NAV excluded',()=>{
  assert.match(external,/CREATE TABLE IF NOT EXISTS external_financial_documents/);
  assert.match(external,/nav_excluded boolean NOT NULL DEFAULT true/);
  assert.match(external,/CHECK\(nav_reporting_owner<>'external' OR nav_excluded=true\)/);
  assert.doesNotMatch(external,/INSERT INTO vir_receipts/);
  assert.match(nav,/FROM vir_receipts r/);
});

test('supported external sources include Invee, Google Drive, Altegio and file import',()=>{
  assert.match(external,/"invee", "google_drive", "altegio", "file_upload", "manual"/);
  assert.match(external,/router\.post\("\/google-drive\/sync"/);
  assert.match(external,/router\.post\("\/altegio\/sync"/);
  assert.match(external,/router\.post\("\/upload"/);
});

test('Drive and Altegio credentials stay in runtime environment, not company settings',()=>{
  assert.match(external,/GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL/);
  assert.match(external,/GOOGLE_DRIVE_PRIVATE_KEY/);
  assert.match(external,/ALTEGIO_PARTNER_TOKEN/);
  assert.match(external,/ALTEGIO_USER_TOKEN/);
  assert.doesNotMatch(external,/private_key text/i);
  assert.doesNotMatch(external,/partner_token text/i);
});

test('provider settings use company and optional location scope with concurrency-safe update then insert',()=>{
  assert.match(settings,/legal_entity_document_settings/);
  assert.match(settings,/UPDATE legal_entity_document_settings/);
  assert.match(settings,/INSERT INTO legal_entity_document_settings/);
  assert.match(settings,/COALESCE\(location_id/);
});

test('external workflow requires review and keeps source evidence',()=>{
  assert.match(external,/pending_review/);
  assert.match(external,/\/documents\/:id\/approve/);
  assert.match(external,/\/documents\/:id\/reject/);
  assert.match(external,/external_financial_document_files/);
  assert.match(external,/external_financial_document_events/);
  assert.match(external,/content_sha256/);
});
