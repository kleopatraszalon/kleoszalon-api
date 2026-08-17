const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'src/sql/20260817_PRODUCT_PRICE_HISTORY_V1.sql'), 'utf8');
const prep = fs.readFileSync(path.join(root, 'src/sql/20260817_PRODUCT_PRICE_HISTORY_PREP.sql'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'src/virSpec/ensureVirSpecModules.ts'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/products/productPricingRuntime.ts'), 'utf8');

test('temporal pricing has dated history and bulk repricing batch model', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_price_versions/i);
  assert.match(sql, /valid_from date NOT NULL/i);
  assert.match(sql, /valid_to date/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_repricing_batches/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_repricing_batch_items/i);
  assert.match(sql, /apply_product_price_interval/i);
  assert.match(sql, /effective_product_price\(/i);
});

test('temporary repricing preserves the old price before and after the interval', () => {
  assert.match(sql, /SET valid_to=p_valid_from-1/i);
  assert.match(sql, /p_valid_to\+1,v_old_to,'interval-continuation'/i);
  assert.match(sql, /cancelled_at=now\(\)/i);
});

test('closed work order price remains a snapshot and new product lines resolve dated price', () => {
  assert.match(sql, /product_price_version_id/i);
  assert.match(sql, /pricing_date date/i);
  assert.match(sql, /BEFORE INSERT ON work_order_items/i);
  assert.match(sql, /NEW\.unit_price:=v_price/i);
  assert.match(sql, /NEW\.line_total:=GREATEST/i);
  assert.doesNotMatch(sql, /BEFORE UPDATE ON work_order_items/i);
});

test('sales repricing does not modify inventory purchase or weighted-average cost', () => {
  const syncFn = sql.match(/CREATE OR REPLACE FUNCTION sync_current_product_prices\(\)[\s\S]*?\$\$;/i)?.[0] || '';
  assert.ok(syncFn, 'sync_current_product_prices function is missing');
  assert.doesNotMatch(syncFn, /unit_cost/i);
  assert.doesNotMatch(syncFn, /purchase_price_net/i);
  assert.doesNotMatch(syncFn, /average_price/i);
  assert.match(syncFn, /retail_price_gross=e\.current_price/i);
  assert.match(syncFn, /price=e\.current_price/i);
});

test('legacy current-price fields stay compatible and scheduled dates auto-sync', () => {
  assert.match(prep, /ADD COLUMN IF NOT EXISTS updated_at/i);
  assert.match(sql, /capture_legacy_product_price_change/i);
  assert.match(sql, /legacy-product-edit/i);
  assert.match(runtime, /PRODUCT_PRICE_SYNC_MINUTES \|\| 5/i);
  assert.match(runtime, /sync_current_product_prices\(\)/i);
  assert.match(bootstrap, /20260817_PRODUCT_PRICE_HISTORY_PREP\.sql/);
  assert.match(bootstrap, /20260817_PRODUCT_PRICE_HISTORY_V1\.sql/);
  assert.match(bootstrap, /startProductPricingWorker\(\)/);
});

test('bulk repricing supports product scopes, percent/fixed/set and date range', () => {
  for (const scope of ['all','merchandise','service_material','group','category','products']) {
    assert.ok(sql.includes(`'${scope}'`), `missing scope ${scope}`);
  }
  for (const mode of ['percent','fixed','set']) {
    assert.ok(sql.includes(`'${mode}'`), `missing adjustment mode ${mode}`);
  }
  assert.match(sql, /valid_from/i);
  assert.match(sql, /valid_to/i);
  assert.match(sql, /rounding_increment/i);
  assert.match(sql, /Csoportos termék átárazás/i);
});
