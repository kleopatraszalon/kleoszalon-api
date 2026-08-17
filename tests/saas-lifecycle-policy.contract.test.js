const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const policy=fs.readFileSync(path.join(__dirname,'..','src','routes','saasLifecyclePolicy.ts'),'utf8');
const saas=fs.readFileSync(path.join(__dirname,'..','src','routes','saas.ts'),'utf8');

test('lifecycle policy is mounted under protected SaaS platform API',()=>{
  assert.match(saas,/saasLifecyclePolicyRouter/);
  assert.match(saas,/router\.use\("\/platform",saasLifecyclePolicyRouter\)/);
  assert.match(policy,/router\.use\(requirePlatformAdmin\)/);
  assert.match(policy,/PLATFORM_ADMIN_FORBIDDEN/);
});

test('lifecycle policy exposes preview and explicit apply operations',()=>{
  assert.match(policy,/router\.get\("\/lifecycle-policy"/);
  assert.match(policy,/router\.post\("\/lifecycle-policy\/apply"/);
  assert.match(policy,/TRIAL_WARNING_DAYS=3/);
  assert.match(policy,/TRIAL_GRACE_DAYS=3/);
});

test('automatic suspension is revalidated under row locks and audited',()=>{
  assert.match(policy,/FOR UPDATE/);
  assert.match(policy,/lifecycle_auto_suspended/);
  assert.match(policy,/platform_policy/);
  assert.match(policy,/UPDATE tenants SET status='suspended'/);
  assert.match(policy,/UPDATE subscriptions SET status='suspended'/);
});

test('central Kleopatra tenant is excluded from lifecycle policy candidates',()=>{
  assert.match(policy,/t\.slug<>'kleopatra'/);
});
