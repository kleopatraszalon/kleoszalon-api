'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('transaction trace ledger is append-only and hash chained',()=>{
 const src=read('src/services/transactionTraceability.ts');
 for(const marker of ['business_transaction_traces','business_transaction_entities','business_transaction_events','business_transaction_verifications','kleo_append_transaction_event','previous_hash','event_hash','SHA-256','sha256','trg_business_transaction_events_immutable'])assert.ok(src.includes(marker),marker);
 for(const table of ['appointments','work_orders','work_order_payments','work_order_settlements','financial_movements','finance_invoices','nav_invoice_queue','accounting_journal_entries','purchase_orders','purchase_order_items','procurement_receipt_costs','inventory_movements'])assert.ok(src.includes(`'${table}'`),table);
});

test('runtime reconstructs complete work order and procurement evidence chains',()=>{
 const src=read('src/services/transactionTraceRuntime.ts');
 for(const marker of ['materializeWorkOrder','appointments','work_order_settlements','work_order_payments','financial_movements','finance_invoices','nav_invoice_queue','accounting_journal_entries'])assert.ok(src.includes(marker),marker);
 for(const marker of ['materializePurchaseOrder','purchase_order_items','procurement_receipt_costs','inventory_movements'])assert.ok(src.includes(marker),marker);
 for(const step of ['Foglalás','Munkalap','Fizetés','Settlement','Pénztár','Pénzügyi tranzakció','Számla','NAV','Főkönyv','Jóváhagyás','Bevételezés','Készlet','Könyvelés'])assert.ok(src.includes(step),step);
 assert.match(src,/35 2 \* \* \*/);
 assert.match(src,/Europe\/Budapest/);
});

test('HMAC proof checkpoint is external-key signed and immutable',()=>{
 const src=read('src/services/transactionTraceSigning.ts');
 for(const marker of ['TRANSACTION_TRACE_HMAC_KEY','HMAC-SHA256','createHmac','timingSafeEqual','business_transaction_proof_signatures','trg_business_transaction_signature_immutable','KLEO-TRACE-PROOF-V1'])assert.ok(src.includes(marker),marker);
 assert.match(src,/\*\/15 \* \* \* \*/);
});

test('management API exposes trace search detail verification and backfill',()=>{
 const route=read('src/routes/businessReconciliation.ts');
 for(const endpoint of ['/trace/recent','/trace/search','/trace/backfill','/trace/:root_type/:root_id','/trace/:root_type/:root_id/verify','/trace/:root_type/:root_id/signature'])assert.ok(route.includes(endpoint),endpoint);
 assert.ok(route.includes('startTraceMaintenance()'));
 assert.ok(route.includes('startTraceProofSigningMaintenance()'));
});

test('release control blocks broken or unsigned transaction trace proof',()=>{
 const src=read('src/middleware/releaseControlProcessIntegrity.ts');
 for(const marker of ['business.transaction_trace','TRANSACTION_TRACE_HMAC_KEY','business_transaction_proof_signatures','integrity_status=\'broken\'','unsigned_stale_30d'])assert.ok(src.includes(marker),marker);
 assert.match(src,/blocking:true/);
});

test('transaction trace menu is registered for finance management',()=>{
 const src=read('src/services/businessControlMenu.ts');
 assert.ok(src.includes("finance.transaction_trace"));
 assert.ok(src.includes("Tranzakció-életút"));
 assert.ok(src.includes("/finance/transaction-trace"));
});
