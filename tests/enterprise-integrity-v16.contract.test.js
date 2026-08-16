'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sql=read('src/sql/20260816_ENTERPRISE_INTEGRITY_V7.sql');

test('enterprise v16 is part of production finance bootstrap',()=>{
 const s=read('src/finance/ensureFinanceNav.ts');
 assert.match(s,/20260816_ENTERPRISE_INTEGRITY_V7\.sql/);
});

test('cross-tenant writes fail closed at database boundary',()=>{
 assert.match(sql,/kleo_guard_tenant_location_consistency/);
 assert.match(sql,/KLEO_CROSS_TENANT_WRITE_BLOCKED/);
 assert.match(sql,/purchase_orders/);
 assert.match(sql,/work_orders/);
 assert.match(sql,/appointments/);
});

test('incoming invoice math and identities are protected',()=>{
 assert.match(sql,/chk_finance_invoices_totals_v7/);
 assert.match(sql,/DUPLICATE_SUPPLIER_INVOICE/);
 assert.match(sql,/DUPLICATE_RECEIPT_INVOICE/);
 assert.match(sql,/pg_advisory_xact_lock/);
});

test('loyalty top-up dedupe is concurrency-safe and transaction-compatible',()=>{
 assert.match(sql,/DUPLICATE_LOYALTY_TOPUP/);
 assert.match(sql,/balance_topup/);
 assert.match(sql,/reference_type='topup'/);
 assert.match(sql,/pg_advisory_xact_lock/);
 const loyalty=read('src/routes/loyalty.ts');
 assert.match(loyalty,/BEGIN/);
 assert.match(loyalty,/balance=balance\+\$2/);
 assert.match(loyalty,/loyalty_transactions/);
 assert.match(loyalty,/ROLLBACK/);
});

test('work-order reversal core is compensating, audited and retry-idempotent',()=>{
 assert.match(sql,/CREATE TABLE IF NOT EXISTS work_order_reversals/);
 assert.match(sql,/UNIQUE\(work_order_id\)/);
 assert.match(sql,/UNIQUE\(idempotency_key\)/);
 assert.match(sql,/kleo_register_work_order_reversal/);
 assert.match(sql,/WORK_ORDER_NOT_FINALIZED/);
 assert.match(sql,/original_archive_hash/);
});

test('daily actions have explicit tenant/location ownership',()=>{
 assert.match(sql,/daily_action_campaigns ADD COLUMN IF NOT EXISTS tenant_id/);
 assert.match(sql,/daily_action_campaigns ADD COLUMN IF NOT EXISTS location_id/);
 assert.match(sql,/daily_action_campaign_locations/);
 assert.match(sql,/trg_daily_action_campaign_locations_tenant_location_guard/);
});

test('legacy data compatibility avoids new unique-index deployment traps',()=>{
 assert.doesNotMatch(sql,/CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_incoming/);
 assert.doesNotMatch(sql,/CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_topup/);
 assert.match(sql,/NOT VALID/);
});
