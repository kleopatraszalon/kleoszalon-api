'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('reversal API is mounted before generic work-order lifecycle handlers',()=>{
 const s=read('src/routes/workordersLifecycleHotfix.ts');
 assert.match(s,/import workOrderReversalApi from '\.\/workOrderReversalApi'/);
 assert.match(s,/router\.use\(workOrderReversalApi\)/);
});

test('reversal request is admin-only and requires business idempotency',()=>{
 const s=read('src/routes/workOrderReversalApi.ts');
 assert.match(s,/router\.post\('\/:id\/reversal-request'/);
 assert.match(s,/isAdmin\(req\.user\?\.role\)/);
 assert.match(s,/REVERSAL_ADMIN_REQUIRED/);
 assert.match(s,/Idempotency-Key/);
 assert.match(s,/REVERSAL_IDEMPOTENCY_KEY_REQUIRED/);
 assert.match(s,/reason\.length<5/);
 assert.match(s,/kleo_register_work_order_reversal/);
});

test('reversal audit read is limited to admin/accounting roles',()=>{
 const s=read('src/routes/workOrderReversalApi.ts');
 assert.match(s,/router\.get\('\/:id\/reversal'/);
 assert.match(s,/accounting/);
 assert.match(s,/bookkeeper/);
 assert.match(s,/work_order_reversals/);
});

test('v8 database function serializes the idempotency key and rejects cross-workorder reuse',()=>{
 const s=read('src/sql/20260816_WORKORDER_REVERSAL_API_V8.sql');
 assert.match(s,/pg_advisory_xact_lock/);
 assert.match(s,/REVERSAL_IDEMPOTENCY_KEY_CONFLICT/);
 assert.match(s,/key_row\.work_order_id IS DISTINCT FROM p_work_order_id/);
 assert.match(s,/WORK_ORDER_NOT_FINALIZED/);
});

test('v8 migration is part of finance bootstrap after v7 integrity core',()=>{
 const s=read('src/finance/ensureFinanceNav.ts');
 const v7='20260816_ENTERPRISE_INTEGRITY_V7.sql',v8='20260816_WORKORDER_REVERSAL_API_V8.sql';
 assert.ok(s.includes(v7));assert.ok(s.includes(v8));assert.ok(s.indexOf(v7)<s.indexOf(v8));
});
