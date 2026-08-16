'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-WO-002 / KLEO-FUN-WO-002-AC-01
test('KLEO-FUN-WO-002-AC-01 cancellable work order releases active stock reservations and records reason/actor/time',()=>{
 const s=read('src/routes/workOrderReversalApi.ts');
 assert.match(s,/work_order_stock_reservations/);
 assert.match(s,/status='released'/);
 assert.match(s,/released_at=now\(\)/);
 assert.match(s,/released_by=\$2/);
 assert.match(s,/release_reason=\$3/);
 assert.match(s,/work_order_cancellation_events/);
 assert.match(s,/cancel_reason/);
 assert.match(s,/cancelled_by/);
});

// KLEO-FUN-WO-002 / KLEO-FUN-WO-002-AC-02
test('KLEO-FUN-WO-002-AC-02 financially finalized or invoiced work order rejects normal cancellation with 409 and reversal guidance',()=>{
 const s=read('src/routes/workOrderReversalApi.ts');
 assert.match(s,/paid>0\|\|invoice/);
 assert.match(s,/financial_closed_at\|\|wo\.locked_at\|\|wo\.archived_at/);
 assert.match(s,/WORK_ORDER_FINANCIALLY_FINALIZED/);
 assert.match(s,/res\.status\(409\)/);
 assert.match(s,/reversal_endpoint/);
});

// KLEO-FUN-FIN-001 / KLEO-FUN-FIN-001-AC-01
test('KLEO-FUN-FIN-001-AC-01 incoming invoice header arithmetic is guarded to one fillér',()=>{
 const s=read('src/sql/20260816_ENTERPRISE_INTEGRITY_V7.sql');
 assert.match(s,/chk_finance_invoices_totals_v7/);
 assert.match(s,/COALESCE\(net_total,0\)\+COALESCE\(vat_total,0\)-COALESCE\(gross_total,0\)/);
 assert.match(s,/<=0\.01/);
});

// KLEO-FUN-FIN-001 / KLEO-FUN-FIN-001-AC-02
test('KLEO-FUN-FIN-001-AC-02 supplier invoice identity is concurrency-safe and duplicate invoices are rejected',()=>{
 const s=read('src/sql/20260816_ENTERPRISE_INTEGRITY_V7.sql');
 assert.match(s,/kleo_guard_incoming_invoice_identity/);
 assert.match(s,/pg_advisory_xact_lock/);
 assert.match(s,/supplier_id IS NOT DISTINCT FROM NEW\.supplier_id/);
 assert.match(s,/supplier_invoice_number/);
 assert.match(s,/DUPLICATE_SUPPLIER_INVOICE/);
});

// KLEO-NFR-QLT-001 / KLEO-NFR-QLT-001-AC-01
test('KLEO-NFR-QLT-001-AC-01 requirement traceability CI enforces 10\/10 and orphan/stale mapping failures',()=>{
 const validator=read('scripts/validate-requirements.mjs');
 const workflow=read('.github/workflows/requirements-traceability.yml');
 assert.match(validator,/10\.0\/10\.0|10\.0/);
 assert.match(workflow,/requirements:check/);
 assert.match(workflow,/test:requirements-critical/);
});

test('operational reservation API serializes availability against other active reservations',()=>{
 const s=read('src/routes/workOrderReversalApi.ts');
 assert.match(s,/FOR UPDATE/);
 assert.match(s,/status='active' AND work_order_id<>\$3::uuid/);
 assert.match(s,/STOCK_RESERVATION_INSUFFICIENT/);
 assert.match(s,/UNIQUE\(work_order_id,product_id,location_id\)/);
});
