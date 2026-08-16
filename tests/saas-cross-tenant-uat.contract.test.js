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
  assert.match(script, /assertOwnOnly/);
  assert.match(script, /tenant A can see tenant B \$\{table\} row/);
  assert.match(script, /tenant B can see tenant A \$\{table\} row/);
  assert.match(script, /foreign tenant location rejected/);
  assert.match(script, /foreign client\/employee\/appointment\/work-order entities rejected/);
});

test('cross-tenant UAT covers every release-critical SaaS business entity', () => {
  for (const table of ['clients','employees','appointments','work_orders']) {
    assert.match(script, new RegExp(`assertOwnOnly\\('${table}'`));
  }
  assert.match(script, /\['clients',clientB\],\['employees',employeeB\],\['appointments',appointmentB\],\['work_orders',workOrderB\]/);
});

test('package exposes SaaS isolation UAT command', () => {
  assert.equal(pkg.scripts['test:saas-isolation'], 'node scripts/saas-cross-tenant-uat.js');
});
