const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'vir.ts'), 'utf8');

test('VIR reports use a short bounded read cache', () => {
  assert.match(source, /REPORT_CACHE_TTL_MS\s*=\s*30_000/);
  assert.match(source, /const reportCache = new Map/);
  assert.match(source, /reportCache\.size > 500/);
  assert.match(source, /entry\.expiresAt <= now/);
});

test('cache keys isolate report dimensions', () => {
  assert.match(source, /cacheKey\("dashboard", \[from, to, locationId\]\)/);
  assert.match(source, /cacheKey\("revenue-series", \[from, to, locationId\]\)/);
  assert.match(source, /cacheKey\("cancellation-stats", \[from, to, locationId\]\)/);
  assert.match(source, /cacheKey\("kiosk-conversion", \[from, to, locationId\]\)/);
  assert.match(source, /cacheKey\("top-services", \[limit\]\)/);
  assert.match(source, /cacheKey\("top-staff", \[limit\]\)/);
});

test('all heavy VIR read endpoints are cached', () => {
  for (const name of ['dashboard','revenue-series','top-services','top-staff','source-performance','cancellation-stats','kiosk-conversion','signage-impact']) {
    assert.match(source, new RegExp(`cacheKey\\(\\"${name}\\"`));
  }
});
