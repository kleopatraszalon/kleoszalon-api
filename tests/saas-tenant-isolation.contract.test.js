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

test('critical business tables are tenant-backfilled before scoped access', () => {
  const source = read('src/saas/ensureTenantIsolation.ts');
  for (const table of ['employees', 'clients', 'appointments', 'work_orders', 'product_stock_balances', 'purchase_orders']) {
    assert.ok(source.includes(`"${table}"`), `${table} missing from SaaS isolation bootstrap`);
  }
  assert.match(source, /ALTER TABLE \$\{table\} ADD COLUMN IF NOT EXISTS tenant_id bigint/);
  assert.match(source, /SET tenant_id=l\.tenant_id/);
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
