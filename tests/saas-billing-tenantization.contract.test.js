const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const core=fs.readFileSync('src/saas/ensureSaasCore.ts','utf8');
const isolation=fs.readFileSync('src/saas/ensureTenantIsolation.ts','utf8');

test('SaaS billing lifecycle is durable and webhook-idempotent',()=>{
  for(const marker of ['subscription_events','subscription_invoices','billing_webhook_events','cancel_at_period_end','grace_period_end','last_payment_status']) assert.ok(core.includes(marker),`missing ${marker}`);
  assert.ok(core.includes('UNIQUE(provider,external_event_id)'),'billing webhook events must be idempotent');
  assert.ok(core.includes('subscriptions_external_provider_uq'),'external subscription id must be provider-unique');
});

test('finance payroll and marketing records receive tenant ownership',()=>{
  for(const marker of ['payroll_runs','payroll_settings','daily_actions','marketing_campaigns','newsletter_campaigns','financial_transactions','finance_transactions']) assert.ok(isolation.includes(`"${marker}"`),`missing tenantized table ${marker}`);
  for(const marker of ['leave_requests','employment_contracts','employee_compensation_assignments']) assert.ok(isolation.includes(`"${marker}"`),`missing employee tenant inheritance ${marker}`);
  for(const marker of ['payroll_run_items','payroll_commission_links','invoice_items','work_order_commission_events']) assert.ok(isolation.includes(`table: "${marker}"`),`missing parent tenant inheritance ${marker}`);
});

test('tenant backfill prefers location employee or parent ownership before legacy fallback',()=>{
  const locationPos=isolation.indexOf('SET tenant_id=l.tenant_id');
  const employeePos=isolation.indexOf('SET tenant_id=e.tenant_id');
  const parentPos=isolation.indexOf('SET tenant_id=p.tenant_id');
  const fallbackPos=isolation.indexOf('fallbackLegacy');
  assert.ok(locationPos>0&&employeePos>0&&parentPos>0&&fallbackPos>0);
  assert.ok(isolation.includes("WHERE e.tenant_id IS NULL")&&isolation.includes("WHERE c.tenant_id IS NULL"),'backfill must not overwrite explicit tenant ownership');
});
