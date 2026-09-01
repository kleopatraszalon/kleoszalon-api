const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const finance = fs.readFileSync(path.join(__dirname, '..', 'src/finance/ensureFinanceNav.ts'), 'utf8');
const materials = fs.readFileSync(path.join(__dirname, '..', 'src/routes/workOrderMaterials.ts'), 'utf8');

test('runtime schema bootstraps share one serialized lock', () => {
  assert.ok(finance.includes('withRuntimeSchemaBootstrapLock'), 'shared bootstrap lock helper must exist');
  assert.ok(finance.includes('pg_advisory_lock'), 'cross-instance PostgreSQL advisory lock must exist');
  assert.ok(finance.includes('PG_POOL_MAX>1'), 'single-connection pool must avoid advisory-lock self-starvation');
  assert.ok(finance.includes('ensurePromise=withRuntimeSchemaBootstrapLock(async()=>'), 'Finance bootstrap must use the shared lock');
  assert.ok(materials.includes('readyPromise=withRuntimeSchemaBootstrapLock(async()=>'), 'work-order materials bootstrap must use the shared lock');
});

test('work-order materials no longer forces the full Finance/NAV migration chain', () => {
  assert.equal(materials.includes('await ensureFinanceNav();'), false, 'materials bootstrap must stay decoupled from Finance/NAV bootstrap');
});
