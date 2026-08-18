const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('read-only dashboard request is not blocked by full tenant schema mutation bootstrap', () => {
  const src = read('src/middleware/locationManagerScope.ts');
  assert.match(src, /if\(kind!=="dashboard"\)await ensureTenantIsolation\(\)/,
    'dashboard request path must not run the full legacy tenant isolation DDL bootstrap');
  assert.match(src, /const tenant=await resolveTenantIdentity\(req\)/,
    'dashboard still has to resolve an authenticated tenant identity');
  assert.match(src, /tenantLocationIds\(tenant\.id\)/,
    'dashboard still has to validate the user location against the active tenant');
  assert.match(src, /locationBelongsToTenant\(requested,tenant\.id\)/,
    'explicit dashboard location filters must remain tenant-bound');
});

test('dashboard tenant resolution repairs stale tenant id from the signed salon without widening scope', () => {
  const src = read('src/saas/tenantAccess.ts');
  assert.match(src, /function isDashboardRequest\(req:AuthRequest\):boolean/,
    'dashboard-specific stale token recovery must be explicit');
  assert.match(src, /const tokenRow=tokenTenantId\?await tenantFromToken\(userId,tokenTenantId\):null/,
    'explicit token tenant is still resolved first');
  assert.match(src, /const locationRow=await tenantFromAuthenticatedLocation\(userId,authUser\.location_id,authUser\.role\)/,
    'the signed location must also be resolved');
  assert.match(src, /if\(isDashboardRequest\(req\)&&locationRow&&\(!tokenRow\|\|String\(locationRow\.id\)!==String\(tokenRow\.id\)\)\)row=locationRow/,
    'dashboard must switch to the signed salon tenant when a stale token tenant disagrees');
  assert.match(src, /tenant\/location boundary middleware/,
    'the recovery path must document that normal tenant/location checks still apply');
});

test('legacy dashboard tenant resolution still supports signed salon then membership then fallback', () => {
  const src = read('src/saas/tenantAccess.ts');
  const locationPos = src.indexOf('tenantFromAuthenticatedLocation(userId,authUser.location_id,authUser.role)');
  const membershipPos = src.indexOf('tenantFromMembership(userId)');
  const fallbackPos = src.indexOf("slug='kleopatra'");
  assert.ok(locationPos >= 0 && membershipPos > locationPos && fallbackPos > membershipPos,
    'legacy resolution must keep signed location -> membership -> legacy fallback available');
  assert.match(src, /if\(!row&&!tokenTenantId\)row=locationRow/,
    'legacy location fallback remains limited to sessions without a tenant id outside dashboard recovery');
});

test('location-manager dashboard client counter is fail-soft', () => {
  const src = read('src/middleware/locationManagerScope.ts');
  assert.match(src, /if\(kind==="dashboard"\)\{[\s\S]*?let ownClients=0;[\s\S]*?try\{[\s\S]*?FROM clients WHERE location_id::text=\$1[\s\S]*?catch\(error:any\)/,
    'an optional location client counter query must not turn the whole dashboard into HTTP 500');
  assert.match(src, /\[dashboard-scope\] telephelyi ügyfélszám nem olvasható/,
    'degraded location counter must stay diagnosable in server logs');
});
