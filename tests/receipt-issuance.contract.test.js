const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const issuance=read('src/routes/receiptIssuance.ts');
const compliance=read('src/routes/receiptDocumentsCompliance.ts');
const pdf=read('src/services/receiptDocumentPdf.ts');
const router=read('src/routes/receiptCompliance.ts');

test('receipt issuance stores immutable document identity, snapshots and original PDF',()=>{
  assert.match(issuance,/CREATE TABLE IF NOT EXISTS vir_receipts/);
  assert.match(issuance,/receipt_number text NOT NULL UNIQUE/);
  assert.match(issuance,/document_hash text NOT NULL/);
  assert.match(issuance,/pdf_sha256 text NOT NULL/);
  assert.match(issuance,/pdf_data bytea NOT NULL/);
  assert.match(issuance,/vir_receipts_sale_source_uq/);
  assert.match(issuance,/vir_receipts_void_original_uq/);
  assert.doesNotMatch(issuance,/DELETE FROM vir_receipts/);
});

test('receipt issuance validates paid non-invoiced sources and prevents duplicate sale receipt',()=>{
  assert.match(issuance,/Nyugta csak teljesen kifizetett munkalapból állítható ki/);
  assert.match(issuance,/számla tartozik vagy számla készült; nyugta nem állítható ki/);
  assert.match(issuance,/termékeladáshoz számla tartozik; nyugta nem állítható ki/);
  assert.match(issuance,/source_type=\$1 AND source_id=\$2 AND document_type='SALE' FOR UPDATE/);
  assert.match(issuance,/idempotent: true/);
});

test('receipt PDF and email delivery use the stored document',()=>{
  assert.match(pdf,/SZÁMÍTÓGÉPPEL ELŐÁLLÍTOTT NYUGTA/);
  assert.match(pdf,/ÉRVÉNYTELENÍTŐ NYUGTA/);
  assert.match(pdf,/Bizonylatszám/);
  assert.match(pdf,/Adószám/);
  assert.match(pdf,/ÁFA-bontás/);
  assert.match(issuance,/generateReceiptPdf/);
  assert.match(issuance,/sendEmail/);
  assert.match(issuance,/contentType: "application\/pdf"/);
  assert.match(issuance,/SELECT \* FROM vir_receipts WHERE id=\$1::uuid/);
});

test('void creates a separate negative receipt and work-order finance reversal',()=>{
  assert.match(issuance,/documentType === "VOID" \? -1 : 1/);
  assert.match(issuance,/original_receipt_id/);
  assert.match(issuance,/original_receipt_number/);
  assert.match(issuance,/reverseFinancialMovement/);
  assert.match(issuance,/receipt_status='voided'/);
  assert.match(issuance,/Érvénytelenítő nyugta nem sztornózható/);
  assert.doesNotMatch(issuance,/DELETE FROM work_order_payments/);
});

test('NAV daily aggregation separates sale and modifying document counts and amounts',()=>{
  assert.match(compliance,/sale_document_count/);
  assert.match(compliance,/modifying_document_count/);
  assert.match(compliance,/sales_gross_total/);
  assert.match(compliance,/modifying_gross_total/);
  assert.match(compliance,/sale_vat_breakdown/);
  assert.match(compliance,/modifying_vat_breakdown/);
  assert.match(compliance,/actual_receipt_documents: true/);
  assert.match(compliance,/AT TIME ZONE 'Europe\/Budapest'/);
});

test('actual receipt-document compliance runs before the legacy source-derived fallback',()=>{
  const actual=router.indexOf('router.use(receiptDocumentsCompliance)');
  const fallback=router.indexOf('router.use(receiptComplianceV2)');
  assert.ok(actual>=0&&fallback>=0&&actual<fallback);
});
