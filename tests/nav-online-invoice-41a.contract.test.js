const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const xml=read('src/nav/navInvoiceXml.ts');
const route=read('src/routes/navOnlineInvoice.ts');
const lifecycle=read('src/routes/navInvoiceLifecycle.ts');
const migration=read('src/sql/20260811_NAV_ONLINE_INVOICE_41A.sql');
const bootstrap=read('src/finance/ensureFinanceNav.ts');

test('NAV 4.1A maps invoice types to CREATE/MODIFY/STORNO without hardcoded submit operation',()=>{
  assert.match(xml,/NavInvoiceOperation="CREATE"\|"MODIFY"\|"STORNO"/);
  assert.match(route,/const partial=sha3\(operation\+invoiceData\)/);
  assert.match(route,/<invoiceOperation>\$\{operation\}<\/invoiceOperation>/);
  assert.doesNotMatch(route,/sha3\('CREATE'\+invoiceData\)/);
});

test('NAV correction XML contains invoice and line chain references',()=>{
  assert.match(xml,/<invoiceReference>/);
  assert.match(xml,/<originalInvoiceNumber>/);
  assert.match(xml,/<modifyWithoutMaster>false<\/modifyWithoutMaster>/);
  assert.match(xml,/<modificationIndex>/);
  assert.match(xml,/<lineModificationReference>/);
  assert.match(xml,/<lineNumberReference>/);
  assert.match(xml,/<lineOperation>CREATE<\/lineOperation>/);
});

test('NAV invoice lines include mandatory mergedItemIndicator and VAT summaries are grouped',()=>{
  assert.match(xml,/<invoiceLines><mergedItemIndicator>false<\/mergedItemIndicator>/);
  assert.match(xml,/new Map<string,VatGroup>\(\)/);
  assert.match(xml,/groupVatSummaries\(lines\)/);
  assert.match(xml,/<summaryByVatRate>/);
});

test('correction drafts allocate continuous NAV line references and support negative correction amounts',()=>{
  assert.match(lifecycle,/nav_line_number_reference/);
  assert.match(lifecycle,/usedRefs\+i\+1/);
  assert.match(lifecycle,/original_invoice_id\|\|source\.id/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS nav_line_number_reference integer/);
  assert.match(migration,/DROP CONSTRAINT IF EXISTS finance_invoices_amount_ck/);
  assert.match(migration,/upper\(COALESCE\(invoice_type,'NORMAL'\)\) IN \('MODIFY','STORNO'\)/);
});

test('NAV 4.1A migration is part of finance bootstrap',()=>{
  assert.match(bootstrap,/20260811_NAV_ONLINE_INVOICE_41A\.sql/);
});
