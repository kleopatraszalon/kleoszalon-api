const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const migration = read('src/sql/20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql');
const hardening = read('src/sql/20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3.sql');
const bootstrap = read('src/finance/ensureFinanceNav.ts');
const access = read('src/middleware/pathAccess.ts');
const menu = read('src/finance/ensureFinanceV5Menu.ts');
const governance = read('src/routes/fixedAssetGovernance.ts');
const server = read('src/server.ts');

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

test('accounting readiness API exposes chart, asset policy and manufacturer-maintenance readiness', () => {
  assert.match(governance, /\/governance\/readiness/);
  assert.match(governance, /chart_of_accounts/);
  assert.match(governance, /maintenance_source_approved_ready/);
  assert.match(governance, /tao_missing/);
  assert.match(governance, /useful_life_missing/);
  assert.match(governance, /posting_ready/);
});

test('only accounting or admin roles may approve policies and map the company chart', () => {
  assert.match(governance, /APPROVER_ROLES/);
  assert.match(governance, /\/governance\/assets\/:id\/approve/);
  assert.match(governance, /\/governance\/chart\/:code/);
  assert.match(governance, /chart_mapping_forbidden/);
  assert.match(governance, /fixed_asset_approval_forbidden/);
  assert.match(governance, /fixed_asset_gl_export_v/);
});

test('governance router is mounted before the general fixed asset router', () => {
  const importIndex=server.indexOf('fixedAssetGovernanceRouter');
  const govMount=server.indexOf('app.use("/api/fixed-assets",fixedAssetGovernanceRouter)');
  const assetMount=server.indexOf('app.use("/api/fixed-assets",fixedAssetsRouter)');
  assert.ok(importIndex>=0,'governance router import missing');
  assert.ok(govMount>=0,'governance router mount missing');
  assert.ok(assetMount>=0,'fixed asset router mount missing');
  assert.ok(govMount<assetMount,'governance router must be mounted first');
});

test('first-time chart mapping trigger does not access OLD on INSERT path', () => {
  assert.match(hardening, /IF TG_OP='INSERT' THEN/);
  const insertBranch = hardening.slice(hardening.indexOf("IF TG_OP='INSERT' THEN"), hardening.indexOf("IF NEW.external_account_code IS DISTINCT FROM OLD.external_account_code"));
  assert.equal(insertBranch.includes('OLD.'), false);
  assert.match(hardening, /mapping_status := 'approved'/);
});

test('finance startup creates fixed asset schema before applying governance migrations', () => {
  const schemaIndex = bootstrap.indexOf("fixed_assets_schema");
  const governanceV2Index = bootstrap.indexOf("20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql");
  const governanceV3Index = bootstrap.indexOf("20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3.sql");
  assert.ok(schemaIndex >= 0, 'fixed asset schema bootstrap is missing');
  assert.ok(governanceV2Index >= 0, 'fixed asset governance V2 migration is missing');
  assert.ok(governanceV3Index >= 0, 'fixed asset governance V3 migration is missing');
  assert.ok(schemaIndex < governanceV2Index, 'schema must exist before governance migration');
  assert.ok(governanceV2Index < governanceV3Index, 'V2 must run before V3 hardening');
});
