const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'products.ts'), 'utf8');

test('products paginated mode supports the complete admin filter set', () => {
  for (const token of ['group_id','category_id','only_merch','only_service_material','min_price','max_price']) {
    assert.match(route, new RegExp(token));
  }
  assert.match(route, /COALESCE\(g\.name,''\) ILIKE/);
  assert.match(route, /COALESCE\(c\.name,''\) ILIKE/);
  assert.match(route, /total_pages/);
});

test('products full CSV export reuses server-side filter plan', () => {
  assert.match(route, /router\.get\("\/export\.csv"/);
  assert.match(route, /productFilterPlan\(req, pc\)/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /products_export_/);
});

test('legacy non-paginated products response remains available', () => {
  assert.match(route, /const paginated = String\(req\.query\.paginated/);
  assert.match(route, /if \(paginated\)/);
  assert.match(route, /res\.json\(rows\.map\(map\)\)/);
});
