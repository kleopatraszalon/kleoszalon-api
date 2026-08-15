const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'products.ts'), 'utf8');

test('products route keeps legacy response and exposes opt-in pagination', () => {
  assert.match(source, /req\.query\.paginated/);
  assert.match(source, /items:\s*rows\.map\(map\)/);
  assert.match(source, /res\.json\(rows\.map\(map\)\)/);
});

test('paginated product stock aggregation is restricted to selected page', () => {
  assert.match(source, /WITH page_products AS/);
  assert.match(source, /JOIN page_products selected ON selected\.id=psb\.product_id/);
  assert.match(source, /LIMIT \$\{limitParam\} OFFSET \$\{offsetParam\}/);
});

test('schema and stock-table metadata use TTL cache', () => {
  assert.match(source, /META_CACHE_TTL_MS/);
  assert.match(source, /columnCache/);
  assert.match(source, /stockTableCache/);
});
