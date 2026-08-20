const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const core=fs.readFileSync('src/saas/ensureSaasCore.ts','utf8');
const isolation=fs.readFileSync('src/saas/ensureTenantIsolation.ts','utf8');
const migration=fs.readFileSync('src/migrations/20260819_001_saas_tenant_baseline.sql','utf8');
const router=fs.readFileSync('src/routes/saas.ts','utf8');
const billingSql=fs.readFileSync('src/sql/20260816_SAAS_BILLING_V4.sql','utf8');

test('SaaS billing lifecycle is durable and webhook-idempotent',()=>{
  for(const marker of ['subscription_events','subscription_invoices','billing_webhook_events','cancel_at_period_end','grace_period_end','last_payment_status']) assert.ok(migration.includes(marker),`missing ${marker}`);
  assert.ok(migration.includes('UNIQUE(provider,external_event_id)'),'billing webhook events must be idempotent');
  assert.ok(migration.includes('subscriptions_external_provider_uq'),'external subscription id must be provider-unique');
  assert.match(billingSql,/^BEGIN;/);
  assert.match(billingSql,/COMMIT;/);
  assert.match(billingSql,/UNIQUE\(provider,external_event_id\)/);
});

test('finance payroll and marketing records are declared tenant-scoped at runtime readiness',()=>{
  for(const marker of ['payroll_runs','payroll_settings','daily_actions','marketing_campaigns','newsletter_campaigns','financial_transactions','finance_transactions']) assert.ok(isolation.includes(`"${marker}"`),`missing tenantized table ${marker}`);
  for(const marker of ['leave_requests','employment_contracts','employee_compensation_assignments']) assert.ok(isolation.includes(`"${marker}"`),`missing employee tenant inheritance ${marker}`);
  for(const marker of ['payroll_run_items','payroll_commission_links','invoice_items','work_order_commission_events']) assert.ok(isolation.includes(`table: "${marker}"`),`missing parent tenant inheritance ${marker}`);
  assert.match(core,/Runtime SaaS schema readiness check/);
  assert.match(isolation,/Runtime tenant-isolation readiness check/);
});

test('versioned tenant backfill prefers location employee or parent ownership before legacy fallback',()=>{
  assert.ok(migration.includes('SET tenant_id=l.tenant_id'));
  assert.ok(migration.includes('SET tenant_id=e.tenant_id'));
  assert.ok(migration.includes('SET tenant_id=p.tenant_id'));
  assert.ok(migration.includes('e.tenant_id IS NULL')&&migration.includes('c.tenant_id IS NULL'),'backfill must not overwrite explicit tenant ownership');
  assert.ok(migration.includes('UPDATE %I SET tenant_id=$1 WHERE tenant_id IS NULL'),'legacy fallback must only fill unresolved ownership');
});

test('subscription lifecycle is admin controlled, auditable and provider-safe',()=>{
  assert.match(router,/\/subscription\/change-plan/);
  assert.match(router,/\/subscription\/cancel/);
  assert.match(router,/\/subscription\/reactivate/);
  assert.match(router,/requireTenantRole\("owner","admin"\)/);
  assert.match(router,/BILLING_PROVIDER_MANAGED/);
  assert.match(router,/INSERT INTO subscription_events/);
  assert.match(router,/client\.query\("BEGIN"\)/);
  assert.match(router,/client\.query\("COMMIT"\)/);
  assert.match(router,/client\.query\("ROLLBACK"\)/);
});
