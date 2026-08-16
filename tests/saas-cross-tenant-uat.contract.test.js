const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts/saas-cross-tenant-uat.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('cross-tenant UAT is explicit, rollback-safe and seeds two tenants', () => {
  assert.match(script, /SAAS_UAT_DATABASE_URL/);
  assert.match(script, /BEGIN/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /uat-a-/);
  assert.match(script, /uat-b-/);
  assert.match(script, /tenant A can see tenant B client/);
  assert.match(script, /tenant B can see tenant A client/);
  assert.match(script, /foreign tenant location rejected/);
  assert.match(script, /foreign tenant entity rejected/);
});

test('package exposes SaaS isolation UAT command', () => {
  assert.equal(pkg.scripts['test:saas-isolation'], 'node scripts/saas-cross-tenant-uat.js');
});
