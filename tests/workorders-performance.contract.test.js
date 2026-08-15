const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workorders.ts'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'sql', '20260815_WORKORDER_LIST_PERFORMANCE_V1.sql'), 'utf8');

test('workorders route keeps legacy response and exposes opt-in pagination', () => {
  assert.match(route, /req\.query\.paginated/);
  assert.match(route, /if\(!paginated\).*res\.json\(rows\)/s);
  assert.match(route, /items:rows,page,limit,total:count,total_pages/);
  assert.match(route, /Math\.min\(n,max\)/);
});

test('workorders metadata checks use TTL cache', () => {
  assert.match(route, /META_TTL_MS/);
  assert.match(route, /relationCache/);
  assert.match(route, /workOrderColumnsCache/);
  assert.match(route, /relationExists\('v_work_orders_list'\)/);
  assert.match(route, /relationExists\('v_work_order_details'\)/);
});

test('workorders pagination is bounded and uses database limit and offset', () => {
  assert.match(route, /positiveInt\(req\.query\.limit,50,200\)/);
  assert.match(route, /LIMIT \$2 OFFSET \$3/);
  assert.match(route, /COUNT\(\*\)::int total FROM work_orders/);
});

test('workorder list migration covers global and location ordered queries', () => {
  assert.match(migration, /idx_work_orders_created_at_desc/);
  assert.match(migration, /ON work_orders \(created_at DESC\)/);
  assert.match(migration, /idx_work_orders_location_created_at_desc/);
  assert.match(migration, /ON work_orders \(location_id, created_at DESC\)/);
});
