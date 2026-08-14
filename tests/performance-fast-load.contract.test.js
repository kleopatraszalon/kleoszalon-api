const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('dashboard analytics bootstrap skips already applied migration', () => {
  const src = read('src/dashboard/ensureDashboardAnalytics.ts');
  assert.match(src, /schema_migrations/);
  assert.match(src, /20260805_DASHBOARD_ANALYTICS_V1/);
  assert.match(src, /if\s*\(await alreadyApplied\(\)\)/);
});

test('dashboard and management summary use short cache and slow timing', () => {
  for (const file of ['src/routes/dashboard.ts', 'src/routes/managementSummary.ts']) {
    const src = read(file);
    assert.match(src, /shortCache/);
    assert.match(src, /timed/);
  }
});

test('menu GET does not synchronously wait for self-healing', () => {
  const src = read('src/routes/menu.ts');
  const get = src.slice(src.indexOf('router.get("/"'));
  assert.doesNotMatch(get.split('export default router')[0], /await bestEffort\(/);
  assert.match(src, /scheduleMenuMaintenance/);
});
