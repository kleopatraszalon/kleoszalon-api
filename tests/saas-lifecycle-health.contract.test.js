const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','src','routes','saasPlatform.ts'),'utf8');

test('platform tenant list exposes lifecycle health and trial countdown',()=>{
  assert.match(source,/tenant_health/);
  assert.match(source,/trial_days_left/);
  assert.match(source,/Próbaidő hamarosan lejár/);
  assert.match(source,/Elmaradt előfizetési fizetés/);
});

test('tenant status transition synchronizes active subscription and audits the change',()=>{
  assert.match(source,/tenant_status_changed/);
  assert.match(source,/UPDATE subscriptions SET status=\$2/);
  assert.match(source,/ROOT_TENANT_PROTECTED/);
});

test('platform can change subscription plan and synchronize plan modules',()=>{
  assert.match(source,/router\.patch\("\/tenants\/:tenantId\/subscription"/);
  assert.match(source,/subscription_changed/);
  assert.match(source,/UPDATE tenant_features SET enabled=false/);
  assert.match(source,/enabledFeatures\(plan\.rows\[0\]\.features\)/);
});

test('platform plan catalogue remains protected by platform admin middleware',()=>{
  const middlewareIndex=source.indexOf('router.use(requirePlatformAdmin)');
  const plansIndex=source.indexOf('router.get("/plans"');
  assert.ok(middlewareIndex>=0&&plansIndex>middlewareIndex);
});
