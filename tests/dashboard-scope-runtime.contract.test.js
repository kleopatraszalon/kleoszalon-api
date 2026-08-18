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

test('dashboard tenant resolution prefers explicit tenant, then signed salon, then membership, then legacy fallback', () => {
  const src = read('src/saas/tenantAccess.ts');
  assert.match(src, /tenantFromAuthenticatedLocation\(userId,authUser\.location_id,authUser\.role\)/,
    'a signed location_id must be usable to resolve the active tenant when old JWTs have no tenant_id');
  assert.match(src, /FROM locations l[\s\S]*JOIN tenants t ON t\.id=l\.tenant_id/,
    'tenant inference must use the location-to-tenant relation instead of hard-coding the Kleopatra tenant');

  const tokenPos = src.indexOf('tenantFromToken(userId,tokenTenantId)');
  const locationPos = src.indexOf('tenantFromAuthenticatedLocation(userId,authUser.location_id,authUser.role)');
  const membershipPos = src.indexOf('tenantFromMembership(userId)');
  const fallbackPos = src.indexOf("slug='kleopatra'");
  assert.ok(tokenPos >= 0 && locationPos > tokenPos && membershipPos > locationPos && fallbackPos > membershipPos,
    'tenant resolution order must be explicit tenant -> signed location -> membership -> legacy fallback');
  assert.match(src, /if\(!row&&!tokenTenantId\)row=await tenantFromAuthenticatedLocation/,
    'legacy location-based resolution must not override an explicit token tenant');
});

test('location-manager dashboard client counter is fail-soft', () => {
  const src = read('src/middleware/locationManagerScope.ts');
  assert.match(src, /if\(kind==="dashboard"\)\{[\s\S]*?let ownClients=0;[\s\S]*?try\{[\s\S]*?FROM clients WHERE location_id::text=\$1[\s\S]*?catch\(error:any\)/,
    'an optional location client counter query must not turn the whole dashboard into HTTP 500');
  assert.match(src, /\[dashboard-scope\] telephelyi ügyfélszám nem olvasható/,
    'degraded location counter must stay diagnosable in server logs');
});
