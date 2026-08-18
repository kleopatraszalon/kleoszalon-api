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
