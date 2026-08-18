const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('SaaS core exposes first-class tenant and franchise tables', () => {
  const sql = read('src/sql/20260816_SAAS_CORE_V1.sql');
  for (const table of [
    'tenants',
    'tenant_users',
    'tenant_features',
    'subscriptions',
    'franchise_networks',
    'franchise_members',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  }
});

test('critical business tables are tenant-backfilled by migration before scoped access', () => {
  const runtime = read('src/saas/ensureTenantIsolation.ts');
  const migration = read('src/migrations/20260818_001_saas_tenant_baseline.sql');
  for (const table of ['employees', 'clients', 'appointments', 'work_orders', 'product_stock_balances', 'purchase_orders']) {
    assert.ok(runtime.includes(`"${table}"`), `${table} missing from runtime tenant readiness registry`);
    assert.ok(migration.includes(`'${table}'`), `${table} missing from tenant migration`);
  }
  assert.doesNotMatch(runtime, /ALTER TABLE|CREATE INDEX|UPDATE\s+/i);
  assert.match(runtime, /information_schema\.columns/);
  assert.match(migration, /ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id bigint/);
  assert.match(migration, /SET tenant_id=l\.tenant_id/);
});

test('child business and CRM tables inherit tenant ownership from parents in migration', () => {
  const runtime = read('src/saas/ensureTenantIsolation.ts');
  const migration = read('src/migrations/20260818_001_saas_tenant_baseline.sql');
  for (const table of ['appointment_services', 'work_order_items', 'crm_client_tags', 'crm_client_notes', 'crm_form_responses', 'crm_consent_history', 'work_shifts']) {
    assert.ok(runtime.includes(`table: "${table}"`), `${table} missing from child tenant readiness registry`);
    assert.ok(migration.includes(`'${table}'`), `${table} missing from parent tenant migration`);
  }
  assert.doesNotMatch(runtime, /SET tenant_id=p\.tenant_id/);
  assert.match(migration, /SET tenant_id=p\.tenant_id/);
  assert.match(migration, /crm_tags_tenant_name_uq/);
  assert.match(migration, /crm_forms_tenant_title_uq/);
});

test('location manager scope enforces tenant boundary before legacy location rules', () => {
  const source = read('src/middleware/locationManagerScope.ts');
  assert.match(source, /ensureTenantIsolation\(\)/);
  assert.match(source, /resolveTenantIdentity\(req\)/);
  assert.match(source, /locationBelongsToTenant\(requested,tenant\.id\)/);
  assert.match(source, /entityBelongsToTenant\(entity\.table,entity\.id,tenant\.id\)/);
  assert.match(source, /TENANT_LOCATION_FORBIDDEN/);
  assert.match(source, /TENANT_ENTITY_NOT_FOUND/);
  assert.ok(
    source.indexOf('await enforceTenantBoundary(req,res,kind)') < source.indexOf('if(kind==="employees")'),
    'tenant boundary must execute before module-specific rules'
  );
});

test('tenant row filtering rejects mismatched tenant_id and foreign location_id', () => {
  const source = read('src/middleware/locationManagerScope.ts');
  assert.match(source, /String\(row\.tenant_id\)!==tenantId/);
  assert.match(source, /locations\.has\(String\(row\.location_id\)\)/);
  assert.match(source, /filterTenantPayload/);
});

test('tenant access helper only permits an allowlisted business table set', () => {
  const source = read('src/saas/tenantAccess.ts');
  assert.match(source, /const allowed = new Set/);
  assert.match(source, /if \(!allowed\.has\(table\)\) return false/);
  assert.match(source, /e\.tenant_id=\$2::bigint OR l\.tenant_id=\$2::bigint/);
});

test('subscription feature resolver supports plan features, all_modules and tenant overrides', () => {
  const source = read('src/saas/tenantAccess.ts');
  assert.match(source, /tenantFeatureEnabled/);
  assert.match(source, /sp\.features->>'all_modules'/);
  assert.match(source, /LEFT JOIN tenant_features tf/);
  assert.match(source, /COALESCE\(tf\.enabled/);
});

test('scoped business routes are mapped to subscription features and denied when disabled', () => {
  const source = read('src/saas/tenantAccess.ts');
  assert.match(source, /featureForRequest/);
  for (const feature of ['crm', 'booking', 'hr', 'inventory']) {
    assert.ok(source.includes(`return "${feature}"`), `${feature} route mapping missing`);
  }
  assert.match(source, /tenantFeatureEnabled\(tenantId, feature\)/);
  assert.match(source, /tenant_feature_denied = feature/);
});

test('HR scope enforces tenant membership and exposes feature-disabled response', () => {
  const source = read('src/middleware/hrLocationScope.ts');
  assert.match(source, /ensureTenantIsolation\(\)/);
  assert.match(source, /resolveTenantIdentity\(req\)/);
  assert.match(source, /TENANT_FEATURE_DISABLED/);
  assert.match(source, /locationBelongsToTenant\(requested,tenant\.id\)/);
  assert.match(source, /e\.tenant_id=\$5::bigint/);
});

test('dashboard aggregates and counts are scoped inside SQL by tenant', () => {
  const source = read('src/routes/dashboard.ts');
  assert.match(source, /tl\.tenant_id=\$4::bigint/);
  assert.match(source, /FROM clients WHERE tenant_id=\$1::bigint/);
  assert.match(source, /FROM locations WHERE tenant_id=\$1::bigint/);
  assert.match(source, /tenantId,roles\.sort\(\)\.join/);
  assert.match(source, /TENANT_ACCESS_DENIED/);
});
