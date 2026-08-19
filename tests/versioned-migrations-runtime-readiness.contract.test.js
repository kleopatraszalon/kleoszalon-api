const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('production startup runs checksum-protected migrations before API', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.migrate, 'node dist/dbMigrations.js');
  assert.match(pkg.scripts.start, /^npm run migrate && /);

  const runner = read('src/dbMigrations.ts');
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /checksum_sha256/);
  assert.match(runner, /Migration checksum mismatch/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /ROLLBACK/);
  assert.match(runner, /schema_migrations/);
});

test('SaaS runtime readiness code is read-only and cannot mutate schema', () => {
  const saasCore = read('src/saas/ensureSaasCore.ts');
  const isolation = read('src/saas/ensureTenantIsolation.ts');
  const forbidden = /\b(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|INSERT\s+INTO|UPDATE\s+[A-Za-z_])/i;
  assert.doesNotMatch(saasCore, forbidden);
  assert.doesNotMatch(isolation, forbidden);
  assert.match(saasCore, /SaaS migration required/);
  assert.match(isolation, /Tenant isolation migration required/);
});

test('versioned SaaS baseline owns tenant schema and backfill', () => {
  const sql = read('src/migrations/20260819_001_saas_tenant_baseline.sql');
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS tenants',
    'CREATE TABLE IF NOT EXISTS tenant_users',
    'CREATE TABLE IF NOT EXISTS subscriptions',
    'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id bigint',
    "VALUES('kleopatra'",
    'crm_tags_tenant_name_uq',
    'compensation_plans_tenant_name_idx',
  ]) {
    assert.ok(sql.includes(marker), `missing migration marker: ${marker}`);
  }
});

test('build copies migration SQL next to compiled runner', () => {
  const copy = read('scripts/copy-runtime-sql-assets.mjs');
  assert.match(copy, /src", "migrations/);
  assert.match(copy, /dist", "migrations/);
});
