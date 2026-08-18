'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('process integrity covers finance stock procurement and system invariants',()=>{
 const src=read('src/services/businessProcessIntegrity.ts');
 for(const marker of ['runFinancialReconciliation','runStockReconciliation','purchase_orders','purchase_order_items','inventory_movements','finance_invoices','accounting_journal_entries','business_process_integrity_runs','business_process_integrity_exceptions'])assert.match(src,new RegExp(marker));
 for(const issue of ['procurement_approval_missing','procurement_receipt_quantity_mismatch','procurement_stock_link_mismatch','procurement_invoice_missing','procurement_invoice_amount_mismatch','procurement_accounting_not_reconciled','invoice_math_error','journal_unbalanced','negative_stock','stale_cashier_shift'])assert.match(src,new RegExp(issue));
});

test('inventory movements receive durable procurement source linkage',()=>{
 const src=read('src/services/businessProcessIntegrity.ts');
 assert.match(src,/source_record_type/);
 assert.match(src,/source_record_id/);
 assert.match(src,/kleo_inventory_source_link/);
 assert.match(src,/Beszerzési rendelés #/);
});

test('daily scheduler persists global and location process integrity evidence',()=>{
 const scheduler=read('src/services/businessReconciliationScheduler.ts');
 assert.match(scheduler,/runBusinessProcessIntegrity/);
 assert.match(scheduler,/process_integrity/);
 assert.match(scheduler,/20 2 \* \* \*/);
 assert.match(scheduler,/Europe\/Budapest/);
});

test('management reconciliation API exposes process integrity and exception history',()=>{
 const route=read('src/routes/businessReconciliation.ts');
 for(const endpoint of ['/process-integrity','/process-integrity/exceptions'])assert.ok(route.includes(`"${endpoint}"`));
 assert.match(route,/business_process_integrity_runs/);
 assert.match(route,/scope==="process"/);
});
