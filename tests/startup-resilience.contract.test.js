const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

test('VIR spec dependency bootstrap tolerates only transient database outages', () => {
  const src = read('src/virSpec/ensureSpecParityDependencies.ts');

  assert.match(src, /export function isTransientDatabaseError\(error: unknown\): boolean/);
  assert.match(src, /transientNetworkCodes\.has\(code\) \|\| code\.startsWith\("08"\)/);
  assert.match(src, /ECONNREFUSED/);
  assert.match(src, /ETIMEDOUT/);
  assert.match(src, /57P03/);
  assert.match(src, /if \(isTransientDatabaseError\(error\)\)/);
  assert.match(src, /scheduleRetry\(\);\s*return;/);
  assert.match(src, /throw error;/);
});

test('VIR spec dependency retry is bounded and cannot create parallel retry timers', () => {
  const src = read('src/virSpec/ensureSpecParityDependencies.ts');

  assert.match(src, /let retryTimer: ReturnType<typeof setTimeout> \| null = null/);
  assert.match(src, /if \(retryTimer\) return;/);
  assert.match(src, /Math\.max\(1000, configured\)/);
  assert.match(src, /retryTimer = null;\s*void ensureSpecParityDependencies\(\)/);
  assert.match(src, /retryTimer\.unref\?\.\(\)/);
});

test('server retains degraded 503 mode while dependency initialization recovers', () => {
  const server = read('src/server.ts');

  assert.match(server, /error:"db_unreachable"/);
  assert.match(server, /else setTimeout\(\(\)=>initDbDependentThings\(\)\.catch\(\(\)=>\{\}\),15000\)/);
  const listenAt=server.indexOf("app.listen(PORT");
  const initAt=server.indexOf("await initDbDependentThings()");
  const parityAt=server.indexOf("await ensureSpecParityDependencies()");
  assert.ok(listenAt>=0 && initAt>listenAt && parityAt>initAt);
  assert.match(server,/void\(async\(\)=>\{try\{await initDbDependentThings\(\);await ensureSpecParityDependencies\(\);startComplaintMailboxWorker\(\)/);
});
