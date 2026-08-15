const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('VIR performance indexes cover hot location-scoped business tables', () => {
  const src = read('src/performance/ensureVirPerformanceIndexes.ts');
  for (const indexName of [
    'idx_vir_employees_location_active_name',
    'idx_vir_clients_location',
    'idx_vir_appointments_location_start',
    'idx_vir_workorders_location_status',
    'idx_vir_service_locations_location_service',
    'idx_vir_stock_location_product',
  ]) assert.match(src, new RegExp(indexName));
  assert.match(src, /information_schema\.columns/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS/);
});

test('performance index provisioning is part of startup hardening', () => {
  const src = read('src/virSpec/ensureSpecParityDependencies.ts');
  assert.match(src, /ensureVirPerformanceIndexes/);
  assert.match(src, /await ensureVirPerformanceIndexes\(\)/);
});
