const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'src/sql/20260807_UAT_TEST_CENTER_V1.sql'),
  'utf8'
);

test('UAT migration bootstraps menus before repairing or seeding menu rows', () => {
  const menusCreateIndex = sql.indexOf('CREATE TABLE IF NOT EXISTS menus(');
  const firstMenusAlterIndex = sql.indexOf('ALTER TABLE menus ADD COLUMN IF NOT EXISTS');
  const firstMenuInsertIndex = sql.indexOf('INSERT INTO menus(code,name,icon,route');

  assert.ok(menusCreateIndex >= 0, 'minimal menus table bootstrap must exist');
  assert.ok(firstMenusAlterIndex > menusCreateIndex, 'menus table must exist before schema repairs run');
  assert.ok(firstMenuInsertIndex > firstMenusAlterIndex, 'menu schema repairs must run before UAT menu inserts');
});

test('UAT migration repairs legacy menus icon before inserting menu rows', () => {
  const iconRepairIndex = sql.indexOf('ALTER TABLE menus ADD COLUMN IF NOT EXISTS icon text');
  const firstIconUseIndex = sql.indexOf('INSERT INTO menus(code,name,icon,route');

  assert.ok(iconRepairIndex >= 0, 'legacy menus.icon repair must exist');
  assert.ok(firstIconUseIndex > iconRepairIndex, 'menus.icon must be repaired before UAT menu inserts use it');
});

test('UAT migration bootstraps RBAC permissions before assigning the UAT menu', () => {
  const permissionsCreateIndex = sql.indexOf('CREATE TABLE IF NOT EXISTS role_menu_permissions');
  const permissionsUniqueIndex = sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS role_menu_permissions_role_menu_uq');
  const permissionsInsertIndex = sql.indexOf('INSERT INTO role_menu_permissions(role_key,menu_id');

  assert.ok(permissionsCreateIndex >= 0, 'minimal role_menu_permissions bootstrap must exist');
  assert.ok(permissionsUniqueIndex > permissionsCreateIndex, 'RBAC conflict key must exist after table bootstrap');
  assert.ok(permissionsInsertIndex > permissionsUniqueIndex, 'RBAC table and conflict key must exist before assignments');
});
