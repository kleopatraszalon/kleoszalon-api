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

test('dashboard tenant resolution rejects stale signed tenant instead of widening scope', () => {
  const src = read('src/saas/tenantAccess.ts');
  assert.match(src, /const locationRow=await tenantFromAuthenticatedLocation\(userId,authUser\.location_id,authUser\.role\)/,
    'the signed location must be resolved independently');
  assert.match(src, /const tokenRow=await tenantFromToken\(userId,tokenTenantId\)/,
    'an explicit signed tenant claim must be validated');
  assert.match(src, /if\(locationRow&&String\(locationRow\.id\)!==String\(tokenRow\.id\)\)return null/,
    'a signed tenant/location mismatch must fail closed rather than silently changing tenant');
  assert.doesNotMatch(src, /isDashboardRequest/,
    'dashboard must not have a tenant-boundary exception');
});

test('dashboard authenticates exactly once before tenant scope resolution', () => {
  const auth = read('src/middleware/auth.ts');
  const scope = read('src/middleware/locationManagerScope.ts');
  const dashboard = read('src/routes/dashboard.ts');
  assert.match(scope, /if\(req\.user\)return void guard\(req,res,next,kind\)/,
    'scoped middleware must reuse an already authenticated user');
  assert.match(scope, /return requireAuth\(req,res,\(\)=>void guard\(req,res,next,kind\)\)/,
    'scoped middleware authenticates before resolving tenant context');
  assert.doesNotMatch(dashboard, /router\.get\("\/",\s*requireAuth,/,
    'dashboard route must not decode the same JWT again after tenant scope resolution');
  assert.doesNotMatch(dashboard, /import\s*\{[^}]*requireAuth[^}]*\}\s*from\s*["']\.\.\/middleware\/auth["']/,
    'dashboard route must not import an unused inner authentication middleware');
  assert.match(auth, /const sameAuthenticatedUser = previousUser\?\.id != null && decodedId != null && String\(previousUser\.id\) === String\(decodedId\)/,
    'generic repeated authentication must still preserve enriched scope only for the same verified user');
  assert.match(auth, /tenant_id: preservedTenantId \?\? decoded\.tenant_id \?\? null/,
    'generic nested routes remain protected from tenant context loss');
});

test('tenant resolution uses signed salon or a unique membership and never a default fallback', () => {
  const src = read('src/saas/tenantAccess.ts');
  const locationPos = src.indexOf('tenantFromAuthenticatedLocation(userId,authUser.location_id,authUser.role)');
  const uniqueMembershipPos = src.indexOf('tenantFromUniqueMembership(userId)');
  assert.ok(locationPos >= 0 && uniqueMembershipPos > locationPos,
    'resolution should retain signed location then unique membership for sessions without a tenant claim');
  assert.match(src, /LIMIT 2/,
    'membership resolution must detect ambiguous multi-tenant accounts');
  assert.match(src, /rows\.length===1\?rows\[0\]:null/,
    'only exactly one active membership may be inferred');
  assert.doesNotMatch(src, /slug='kleopatra'/,
    'a central/default tenant must never be inferred');
});

test('location-manager dashboard client counter is fail-soft', () => {
  const src = read('src/middleware/locationManagerScope.ts');
  assert.match(src, /if\(kind==="dashboard"\)\{[\s\S]*?let ownClients=0;[\s\S]*?try\{[\s\S]*?FROM clients WHERE location_id::text=\$1[\s\S]*?catch\(error:any\)/,
    'an optional location client counter query must not turn the whole dashboard into HTTP 500');
  assert.match(src, /\[dashboard-scope\] telephelyi ügyfélszám nem olvasható/,
    'degraded location counter must stay diagnosable in server logs');
});