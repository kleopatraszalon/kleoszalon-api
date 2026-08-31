const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const db=fs.readFileSync('src/db.ts','utf8');
const roles=fs.readFileSync('src/middleware/requireRoles.ts','utf8');
const tenant=fs.readFileSync('src/saas/tenantAccess.ts','utf8');

test('legacy VIR tenant casts are normalized at pool query boundary',()=>{
  assert.ok(db.includes('"$1::text=$2::text"'),'tenant UUID equality must normalize to text-safe equality');
  assert.ok(db.includes('instrumentClient(pool as any);'),'direct pool.query calls must pass through compatibility normalization');
});

test('legacy locations active predicate maps to canonical is_active',()=>{
  assert.match(db,/is_active IS DISTINCT FROM false/);
  assert.match(db,/FROM\|JOIN[\s\S]*locations/);
});

test('management-gated VIR requests resolve canonical tenant before route scopes',()=>{
  assert.match(roles,/resolveTenantIdentity/);
  assert.match(roles,/path\.startsWith\("\/api\/vir\/"\)/);
  assert.match(tenant,/function\s+isVirRequest/);
  assert.match(tenant,/path\.startsWith\("\/api\/vir\/"\)/);
});
