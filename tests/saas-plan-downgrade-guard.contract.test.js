const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(rel)=>fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
const migration=read('src/sql/20260817_SAAS_PLAN_DOWNGRADE_GUARD_V13.sql');
const bootstrap=read('src/finance/ensureFinanceNav.ts');

test('SaaS plan downgrade guard validates target plan capacity',()=>{
  assert.match(migration,/saas_guard_subscription_plan_capacity/);
  assert.match(migration,/max_locations/);
  assert.match(migration,/max_users/);
  assert.match(migration,/SAAS_PLAN_LIMIT_BELOW_USAGE/);
});

test('SaaS plan downgrade guard counts only active quota consumers',()=>{
  assert.match(migration,/is_active=true/);
  assert.match(migration,/active=true/);
});

test('SaaS plan downgrade guard covers every subscription plan write',()=>{
  assert.match(migration,/BEFORE INSERT OR UPDATE OF plan_id ON subscriptions/);
  assert.match(migration,/CREATE TRIGGER subscriptions_plan_capacity_guard_trg/);
});

test('SaaS internal root plan remains unlimited and V13 bootstraps after V12',()=>{
  assert.match(migration,/v_plan_code='internal'/);
  assert.match(bootstrap,/20260817_SAAS_QUOTA_ENFORCEMENT_V12\.sql','20260817_SAAS_PLAN_DOWNGRADE_GUARD_V13\.sql/);
  assert.ok(bootstrap.indexOf('20260817_SAAS_PLAN_DOWNGRADE_GUARD_V13.sql')>bootstrap.indexOf('20260817_SAAS_QUOTA_ENFORCEMENT_V12.sql'));
});
