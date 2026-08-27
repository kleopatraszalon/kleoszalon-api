const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const external=read('src/routes/externalFinancialDocuments.ts');
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

test('Altegio integration is export-file only and never calls the Altegio API',()=>{
  assert.match(external,/router\.post\("\/altegio\/import"/);
  assert.match(external,/mode: "export_file"/);
  assert.match(external,/ALTEGIO_API_DISABLED/);
  assert.match(external,/CSV\/XLS\/XLSX/);
  assert.doesNotMatch(external,/ALTEGIO_PARTNER_TOKEN/);
  assert.doesNotMatch(external,/ALTEGIO_USER_TOKEN/);
  assert.doesNotMatch(external,/api\.alteg\.io/);
  assert.doesNotMatch(external,/api\.altegio/);
});

test('Altegio export parser maps workbook rows and archives import batches',()=>{
  assert.match(external,/function altegioRowToDocument/);
  assert.match(external,/function workbookDocuments/);
  assert.match(external,/external_financial_import_batches/);
  assert.match(external,/uq_external_import_batch_hash/);
  assert.match(external,/source_file_sha256/);
  assert.match(external,/duplicate_batch/);
});

test('supported external sources include Invee, Google Drive, Altegio export and file import',()=>{
  assert.match(external,/"invee", "google_drive", "altegio", "file_upload", "manual"/);
  assert.match(external,/router\.post\("\/google-drive\/sync"/);
  assert.match(external,/router\.post\("\/upload"/);
});

test('Google Drive credentials stay in runtime environment, not company settings',()=>{
  assert.match(external,/GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL/);
  assert.match(external,/GOOGLE_DRIVE_PRIVATE_KEY/);
  assert.doesNotMatch(external,/private_key text/i);
  assert.doesNotMatch(external,/partner_token text/i);
});

test('provider settings use company and optional location scope with update then insert',()=>{
  assert.match(external,/legal_entity_document_settings/);
  assert.match(external,/UPDATE legal_entity_document_settings/);
  assert.match(external,/INSERT INTO legal_entity_document_settings/);
  assert.match(external,/location_id IS NOT DISTINCT FROM/);
  assert.match(external,/altegio_location_id=NULL/);
});

test('external workflow requires review and keeps source evidence',()=>{
  assert.match(external,/pending_review/);
  assert.match(external,/\/documents\/:id\/approve/);
  assert.match(external,/\/documents\/:id\/reject/);
  assert.match(external,/external_financial_document_files/);
  assert.match(external,/external_financial_import_batches/);
  assert.match(external,/external_financial_document_events/);
  assert.match(external,/content_sha256/);
});
