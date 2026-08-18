const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const migration = read('src/sql/20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql');
const bootstrap = read('src/finance/ensureFinanceNav.ts');
const access = read('src/middleware/pathAccess.ts');
const menu = read('src/finance/ensureFinanceV5Menu.ts');

test('fixed asset governance migration is fail-closed for accounting and policy approval', () => {
  assert.match(migration, /mapping_status text NOT NULL DEFAULT 'unmapped'/);
  assert.match(migration, /external_account_code_snapshot/);
  assert.match(migration, /kleo_fixed_asset_require_mapped_account/);
  assert.match(migration, /kleo_fixed_asset_validate_policy_approval/);
  assert.match(migration, /kleo_fixed_asset_actor_can_approve/);
  assert.match(migration, /csak a Könyvelés vagy rendszergazda/i);
  assert.match(migration, /fixed_asset_governance_readiness_v/);
  assert.match(migration, /fixed_asset_gl_export_v/);
});

test('legacy master equipment remains review-required and manufacturer source is mandatory', () => {
  assert.match(migration, /legacy_master_equipment/);
  assert.match(migration, /Migrált master_equipment szervizperiódus/);
  assert.match(migration, /depreciation_policy_status='needs_review'/);
  assert.match(migration, /manufacturer_reference/);
  assert.match(migration, /jsonb_array_length\(mp\.checklist\)/);
});

test('accounting role gets explicit all-location fixed asset access', () => {
  assert.match(migration, /\('accounting','fixed_assets',true,'all_locations'/);
  assert.match(migration, /m\.code='finance\.fixed_assets'/);
  assert.match(migration, /can_approve=true/);
  assert.match(menu, /finance\.fixed_assets/);
});

test('fixed asset route is protected by central fail-closed finance RBAC', () => {
  assert.match(access, /path === "\/api\/fixed-assets"/);
  assert.match(access, /menu: "finance\.fixed_assets"/);
  assert.match(access, /feature: "finance"/);
});

test('finance startup creates fixed asset schema before applying governance migration', () => {
  const schemaIndex = bootstrap.indexOf("fixed_assets_schema");
  const governanceIndex = bootstrap.indexOf("20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql");
  assert.ok(schemaIndex >= 0, 'fixed asset schema bootstrap is missing');
  assert.ok(governanceIndex >= 0, 'fixed asset governance migration is missing');
  assert.ok(schemaIndex < governanceIndex, 'schema must exist before governance migration');
});
