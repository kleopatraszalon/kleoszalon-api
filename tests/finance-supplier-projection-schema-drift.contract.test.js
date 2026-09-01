const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src/finance/ensureFinanceNav.ts'),
  'utf8'
);

test('Finance bootstrap repairs legacy supplier columns before V5 projection', () => {
  const compatCall = source.indexOf("await step('supplier_projection_compat'");
  const v5Migration = source.indexOf("'20260813_FINANCE_ALTEGIO_V5.sql'");

  assert.ok(compatCall >= 0, 'supplier projection compatibility step must exist');
  assert.ok(v5Migration > compatCall, 'supplier compatibility repair must run before Finance V5');

  for (const column of [
    'tax_number text',
    'email text',
    'phone text',
    'contact_name text',
    'address text',
    'payment_terms_days integer NOT NULL DEFAULT 0',
    'active boolean NOT NULL DEFAULT true',
    'note text'
  ]) {
    assert.ok(source.includes(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ${column}`), `missing legacy supplier repair for ${column}`);
  }
});
