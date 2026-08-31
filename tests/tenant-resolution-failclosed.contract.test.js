const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'saas', 'tenantAccess.ts'), 'utf8');

test('signed tenant id can only resolve through active tenant membership', () => {
  assert.match(source, /FROM tenant_users tu\s+JOIN tenants t ON t\.id=tu\.tenant_id/);
  assert.match(source, /tu\.user_id=\$1/);
  assert.match(source, /tu\.active=true/);
  assert.match(source, /t\.id::text=\$2/);
});

test('tenant identity resolution has no default Kleopatra fallback', () => {
  assert.doesNotMatch(source, /WHERE slug='kleopatra'/);
  assert.match(source, /if \(!row\) return null/);
  assert.match(source, /fail-closed/i);
});
