const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'src/sql/20260817_PRODUCT_REPRICING_USABILITY_V2.sql'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'src/virSpec/ensureVirSpecModules.ts'), 'utf8');

test('bulk repricing accepts human friendly group/category/product identifiers', () => {
  assert.match(sql, /FROM product_groups g/i);
  assert.match(sql, /FROM product_categories c/i);
  assert.match(sql, /p\.internal_code/i);
  assert.match(sql, /p\.barcode/i);
  assert.match(sql, /regexp_split_to_table/i);
});

test('bulk repricing UI exposes Hungarian operator labels', () => {
  for (const label of [
    'Minden termék',
    'Értékesített termékek',
    'Szolgáltatási anyagok',
    'Termékcsoport',
    'Termékkategória',
    'Kiválasztott termékek',
    'Százalékos változás',
    'Fix Ft eltérés',
    'Konkrét új ár',
  ]) assert.ok(sql.includes(label), `missing label: ${label}`);
});

test('usability normalization migration is part of VIR bootstrap', () => {
  assert.match(bootstrap, /20260817_PRODUCT_REPRICING_USABILITY_V2\.sql/);
});
