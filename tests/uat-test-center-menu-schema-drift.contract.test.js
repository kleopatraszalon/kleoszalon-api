const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'src/sql/20260807_UAT_TEST_CENTER_V1.sql'),
  'utf8'
);

test('UAT migration repairs legacy menus icon before inserting menu rows', () => {
  const iconRepairIndex = sql.indexOf('ALTER TABLE menus ADD COLUMN IF NOT EXISTS icon text');
  const firstIconUseIndex = sql.indexOf('INSERT INTO menus(code,name,icon,route');

  assert.ok(iconRepairIndex >= 0, 'legacy menus.icon repair must exist');
  assert.ok(firstIconUseIndex > iconRepairIndex, 'menus.icon must be repaired before UAT menu inserts use it');
});
