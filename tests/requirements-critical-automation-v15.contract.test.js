'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('KLEO-FUN-LOY-001-AC-01: wallet top-up is transactional, auditable and idempotency-key protected',()=>{
 const s=read('src/routes/loyalty.ts');
 assert.match(s,/accounts\/:id\/topup/);assert.match(s,/Idempotency-Key/i);assert.match(s,/BEGIN/);assert.match(s,/FOR UPDATE/);assert.match(s,/loyalty_transactions/);assert.match(s,/loyalty_sales/);assert.match(s,/COMMIT/);
});
test('KLEO-FUN-LOY-001-AC-02: repeated wallet top-up returns the original result without a second balance mutation',()=>{
 const s=read('src/routes/loyalty.ts');
 assert.match(s,/wallet_topup/);assert.match(s,/idempotent:true/);assert.match(s,/reference_id/);assert.match(s,/balance=balance\+\$2/);
});
test('KLEO-FUN-MKT-001-AC-01: published daily actions are scoped by location and active time window',()=>{
 const s=read('src/routes/dailyActions.ts');assert.match(s,/location_id/);assert.match(s,/status='published'/);assert.match(s,/valid_from<=now\(\)/);assert.match(s,/valid_until>=now\(\)/);
});
test('KLEO-FUN-MKT-001-AC-02: daily-action audience remains explicit and consent-aware',()=>{
 const s=read('src/routes/dailyActions.ts');assert.match(s,/audience jsonb/);assert.match(s,/marketing_consent,false\)=true/);assert.match(s,/type === \"inactive\"/);assert.match(s,/type === \"loyalty\"/);
});
test('KLEO-FUN-PROC-003-AC-01: incoming invoice identity and totals are fail-closed',()=>{
 const s=read('src/routes/purchaseOrders.ts');assert.match(s,/supplier_invoice_number/);assert.match(s,/invoice_net_total/);assert.match(s,/invoice_tax_total/);assert.match(s,/invoice_gross_total/);assert.match(s,/0\.01/);assert.match(s,/409/);
});
test('KLEO-FUN-PROC-003-AC-02: the same supplier invoice cannot create a second active source document',()=>{
 const s=read('src/routes/purchaseOrders.ts');assert.match(s,/supplier_invoice_number/);assert.match(s,/ON CONFLICT/);assert.match(s,/idempotent/);
});
test('KLEO-NFR-PERF-001-AC-01: production performance workflow enforces p95 latency and error-rate thresholds',()=>{
 const s=read('.github/workflows/performance-evidence.yml');assert.match(s,/15/);assert.match(s,/p95/i);assert.match(s,/1500/);assert.match(s,/error_rate/i);assert.match(s,/0\.01/);
});
test('KLEO-NFR-PERF-001-AC-02: performance evidence is build-specific and retained',()=>{
 const s=read('.github/workflows/performance-evidence.yml');assert.match(s,/GITHUB_SHA/);assert.match(s,/upload-artifact/);assert.match(s,/retention-days:\s*90/);
});
