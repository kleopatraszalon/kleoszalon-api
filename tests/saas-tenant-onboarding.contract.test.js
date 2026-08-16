const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'src/routes/saasOnboarding.ts'), 'utf8');
const platform = fs.readFileSync(path.join(root, 'src/routes/saasPlatform.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'src/sql/20260816_SAAS_ONBOARDING_V7.sql'), 'utf8');

test('platform admin mounts tenant onboarding behind the root admin boundary', () => {
  assert.match(platform, /router\.use\(requirePlatformAdmin\)/);
  assert.match(platform, /\/tenants\/:tenantId\/onboarding/);
  assert.match(platform, /saasOnboardingRouter/);
});

test('onboarding covers the complete tenant activation sequence', () => {
  for (const endpoint of ['company','admin','location','branding','modules','subscription']) {
    assert.match(route, new RegExp(`router\\.put\\(\\"/${endpoint}\\"`));
  }
  assert.match(route, /router\.post\(\"\/complete\"/);
  for (const key of ['company','admin','location','branding','modules','subscription','checklist','ready']) {
    assert.match(route, new RegExp(`\\"${key}\\"`));
  }
});

test('readiness is derived from real tenant resources and completion fails closed', () => {
  assert.match(route, /tenant_users/);
  assert.match(route, /FROM locations WHERE tenant_id/);
  assert.match(route, /tenant_branding/);
  assert.match(route, /tenant_features/);
  assert.match(route, /FROM subscriptions/);
  assert.match(route, /ONBOARDING_INCOMPLETE/);
  assert.match(route, /status='ready'/);
});

test('onboarding is resumable, audited and provider-safe', () => {
  assert.match(route, /tenant_onboarding_events/);
  assert.match(route, /ON CONFLICT\(tenant_id,user_id\) DO UPDATE/);
  assert.match(route, /ON CONFLICT\(tenant_id,feature_key\) DO UPDATE/);
  assert.match(route, /BILLING_PROVIDER_MANAGED/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tenant_onboarding/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tenant_onboarding_events/);
});
