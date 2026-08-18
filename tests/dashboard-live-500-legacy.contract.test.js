const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('dashboard migration converts legacy employee identifiers safely before uuid inserts', () => {
  const sql = read('src/sql/20260805_DASHBOARD_ANALYTICS_V1.sql');
  assert.match(sql, /e\.position_id::text\s*~\*/,
    'dashboard migration must validate legacy position_id text before uuid cast');
  assert.match(sql, /e\.position_id::text::uuid/,
    'dashboard migration must explicitly cast validated legacy position_id to uuid');
  assert.match(sql, /e\.location_id::text::uuid\s+location_id/,
    'dashboard migration must normalize legacy location_id through text before uuid storage');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS schema_migrations/,
    'dashboard migration must be able to bootstrap its migration registry');
});

test('dashboard runtime avoids brittle bigint and uuid parameter casts on legacy tenant/location data', () => {
  const src = read('src/routes/dashboard.ts');
  assert.doesNotMatch(src, /tenant_id\s*=\s*\$\d+::bigint/,
    'dashboard tenant scope must not depend on a brittle direct bigint column comparison');
  assert.doesNotMatch(src, /f\.location_id\s*=\s*\$\d+::uuid/,
    'dashboard location scope must not hard-cast request values to uuid');
  assert.match(src, /to_jsonb\(tl\)->>'tenant_id'/,
    'dashboard tenant filtering must tolerate legacy location schemas');
  assert.match(src, /f\.location_id::text=\$3::text/,
    'dashboard location filtering must compare identifiers text-safely');
});

test('optional dashboard dimensions cannot fail the whole management dashboard', () => {
  const src = read('src/routes/dashboard.ts');
  assert.match(src, /async function optionalRows/,
    'dashboard must isolate optional dimension query failures');
  for (const label of ['location', 'position', 'staff', 'absence', 'clients', 'locations']) {
    assert.match(src, new RegExp(`optionalRows\\(\\"${label}\\"`),
      `${label} dashboard dimension must use isolated optional query handling`);
  }
});

test('production build copies SQL runtime assets next to compiled dashboard code', () => {
  const pkg = JSON.parse(read('package.json'));
  const copier = read('scripts/copy-runtime-sql-assets.mjs');
  assert.match(pkg.scripts.build, /copy-runtime-sql-assets\.mjs/,
    'production build must copy runtime SQL assets after TypeScript compilation');
  assert.match(copier, /"src",\s*"sql"/,
    'runtime SQL copier must read from src/sql');
  assert.match(copier, /"dist",\s*"sql"/,
    'runtime SQL copier must publish into dist/sql');
});

test('dashboard migration loader supports compiled and source-tree runtime paths', () => {
  const ensure = read('src/dashboard/ensureDashboardAnalytics.ts');
  assert.match(ensure, /process\.cwd\(\),\s*"dist",\s*"sql"/,
    'dashboard migration loader must resolve the production dist/sql asset');
  assert.match(ensure, /process\.cwd\(\),\s*"src",\s*"sql"/,
    'dashboard migration loader must retain a source-tree fallback');
  assert.match(ensure, /DASHBOARD_MIGRATION_ASSET_MISSING/,
    'missing migration assets must have a diagnosable error code');
});

test('summary and trend failures degrade analytics instead of returning dashboard 500', () => {
  const src = read('src/routes/dashboard.ts');
  assert.match(src, /safeRows\("summary"/,
    'summary query must use fail-soft execution');
  assert.match(src, /safeRows\("trend"/,
    'trend query must use fail-soft execution');
  assert.match(src, /analyticsBootstrapError/,
    'analytics bootstrap failure must be isolated from the dashboard response');
  assert.match(src, /analytics:\{available:!analyticsDegraded,degraded:analyticsDegraded\}/,
    'dashboard response must expose analytics availability');
  assert.match(src, /emptyTrend\(from, to\)/,
    'a missing fact store must still return chart-safe zero data');
});
