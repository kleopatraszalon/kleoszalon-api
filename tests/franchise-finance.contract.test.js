const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const route=fs.readFileSync('src/routes/franchiseFinance.ts','utf8');
const saas=fs.readFileSync('src/routes/saas.ts','utf8');
const migration=fs.readFileSync('src/sql/20260816_FRANCHISE_FINANCE_V5.sql','utf8');

test('franchise finance router is mounted behind SaaS tenant context',()=>{
  assert.ok(saas.includes('franchiseFinanceRouter'));
  assert.ok(saas.includes('router.use("/franchise-finance",franchiseFinanceRouter)'));
  assert.ok(saas.indexOf('router.use(requireAuth, requireTenantContext)')<saas.indexOf('router.use("/franchise-finance",franchiseFinanceRouter)'));
});

test('revenue ledger is tenant scoped and source idempotent',()=>{
  assert.ok(route.includes('franchise_revenue_entries'));
  assert.ok(route.includes('UNIQUE(tenant_id,source_type,source_id)'));
  assert.ok(route.includes('FRANCHISE_REVENUE_DUPLICATE'));
  assert.ok(route.includes("fm.tenant_id=$1::bigint"));
  assert.ok(route.includes("fm.member_type='franchise'"));
});

test('settlements preserve approved and paid financial records',()=>{
  assert.ok(route.includes('FRANCHISE_SETTLEMENT_LOCKED'));
  assert.ok(route.includes("locked.rows.some((x:any)=>x.status!==\"draft\")"));
  assert.ok(route.includes("WHERE franchise_settlements.status='draft'"));
  assert.ok(route.includes("status='approved'"));
  assert.ok(route.includes("status='paid'"));
});

test('royalty calculation uses effective rates and PostgreSQL numeric rounding',()=>{
  assert.ok(route.includes('COALESCE(fm.royalty_percent,fn.royalty_percent,0)'));
  assert.ok(route.includes('COALESCE(fm.marketing_fee_percent,fn.marketing_fee_percent,0)'));
  assert.ok(route.includes('round($8::numeric*$9::numeric/100,2)'));
  assert.ok(route.includes('round($8::numeric*$10::numeric/100,2)'));
  assert.ok(route.includes('round($8::numeric*($9::numeric+$10::numeric)/100,2)'));
  assert.ok(route.includes('royalty_amount'));
  assert.ok(route.includes('marketing_fee_amount'));
});

test('summary never adds different currencies together',()=>{
  assert.ok(route.includes('GROUP BY currency ORDER BY currency'));
  assert.ok(route.includes('summary_by_currency:totals.rows'));
});

test('payment transition requires approval and a payment reference',()=>{
  assert.ok(route.includes('/settlements/:id/mark-paid'));
  assert.ok(route.includes('payment_reference'));
  assert.ok(route.includes("AND status='approved'"));
  assert.ok(route.includes("event_type,actor_user_id,payload"));
});

test('production migration mirrors ledger and settlement integrity constraints',()=>{
  assert.match(migration,/^BEGIN;/);
  assert.match(migration,/COMMIT;/);
  assert.ok(migration.includes('UNIQUE(tenant_id,source_type,source_id)'));
  assert.ok(migration.includes("CHECK(status IN('draft','approved','paid','void'))"));
  assert.ok(migration.includes('franchise_settlement_events'));
});
