const fs=require('fs');
const path=require('path');
const test=require('node:test');
const assert=require('node:assert/strict');

const root=path.resolve(__dirname,'..');
const bridge=fs.readFileSync(path.join(root,'src/routes/externalInvoiceNavBridge.ts'),'utf8');
const migration=fs.readFileSync(path.join(root,'src/sql/20260827_EXTERNAL_INVOICE_NAV_BRIDGE_V6.sql'),'utf8');
const bootstrap=fs.readFileSync(path.join(root,'src/finance/ensureFinanceNav.ts'),'utf8');
const receipt=fs.readFileSync(path.join(root,'src/routes/receiptCompliance.ts'),'utf8');

test('external invoices remain fail-closed until explicit reviewed NAV promotion',()=>{
 assert.match(bridge,/d\.status!==['"]approved['"]/);
 assert.match(bridge,/\['invoice','credit_note'\]/);
 assert.match(bridge,/validateNavXmlPrerequisites/);
 assert.match(bridge,/validateNavInvoiceXmlXsd/);
 assert.match(bridge,/req\.body\?\.confirm!==true/);
 assert.match(bridge,/nav_reporting_owner='vir',nav_excluded=false/);
});

test('NAV credentials are legal-entity scoped and supplier tax number is guarded',()=>{
 assert.match(migration,/legal_entity_id uuid REFERENCES legal_entities/);
 assert.match(migration,/uq_nav_online_invoice_settings_entity_location/);
 assert.match(bridge,/legal_entity_id=\$1::uuid/);
 assert.match(bridge,/entityTax!==digits\(cfg\.supplier_tax_number\)/);
});

test('external invoice lines and migration are production bootstrapped',()=>{
 assert.match(migration,/external_financial_document_lines/);
 assert.match(bootstrap,/20260827_EXTERNAL_INVOICE_NAV_BRIDGE_V6\.sql/);
 assert.match(receipt,/externalInvoiceNavBridgeRouter/);
});

test('external invoice NAV migration is safe on a clean database before route bootstrap',()=>{
 const batchCreate=migration.indexOf('CREATE TABLE IF NOT EXISTS external_financial_import_batches');
 const documentCreate=migration.indexOf('CREATE TABLE IF NOT EXISTS external_financial_documents');
 const firstDocumentAlter=migration.indexOf('ALTER TABLE external_financial_documents');
 assert.ok(batchCreate>=0,'external import batch base table must be created by the migration');
 assert.ok(documentCreate>=0,'external financial document base table must be created by the migration');
 assert.ok(documentCreate<firstDocumentAlter,'base external financial document table must exist before ALTER TABLE statements');
 assert.match(migration,/CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_source_id/);
 assert.match(migration,/CREATE INDEX IF NOT EXISTS external_financial_documents_review_idx/);
});
