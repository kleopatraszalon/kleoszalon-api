'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-FIN-003 / KLEO-FUN-FIN-003-AC-01
test('work-order payments preserve split-payment identity and deterministic remaining amount',()=>{
 const route=read('src/routes/workOrderEditor.ts');
 const payment=read('src/finance/workOrderPaymentIntegrity.ts');
 assert.match(route,/router\.post\('\/:id\/payments'/);
 assert.match(route,/requireIdempotencyKey\(req,'workorder-editor-payment'\)/);
 assert.match(route,/const remaining=Math\.max\(0,money\(dueBase-regularPaid\)\)/);
 assert.match(route,/const regularAfter=money\(regularPaid\+incoming\),left=Math\.max\(0,money\(dueBase-regularAfter\)\)/);
 assert.match(route,/payment_status=\$3,fully_paid=\$4/);
 assert.match(payment,/INSERT INTO work_order_payments/);
 assert.match(payment,/payment_sequence/);
 assert.match(payment,/settlement_key/);
 assert.match(payment,/financial_movement_id/);
});

test('v19 CRM and loyalty integrity migration is part of runtime bootstrap',()=>{
 const bootstrap=read('src/finance/ensureFinanceNav.ts');
 const sql=read('src/sql/20260816_CRM_LOYALTY_INTEGRITY_V9.sql');
 assert.match(bootstrap,/20260816_CRM_LOYALTY_INTEGRITY_V9\.sql/);
 assert.match(sql,/kleo_create_complaint/);
 assert.match(sql,/kleo_close_complaint/);
 assert.match(sql,/COMPLAINT_CLOSING_EVIDENCE_REQUIRED/);
 assert.match(sql,/kleo_loyalty_wallet_topup/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/idempotent/);
});
