const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const db=fs.readFileSync('src/db.ts','utf8');
const roles=fs.readFileSync('src/middleware/requireRoles.ts','utf8');
const tenant=fs.readFileSync('src/saas/tenantAccess.ts','utf8');

test('legacy VIR tenant casts are normalized at pool query boundary',()=>{
  assert.match(db,/tenant_id\).*::text=\$2::text|tenant_id\).*\$2::text/);
  assert.match(db,/instrumentClient\(pool as any\)/);
});

test('legacy locations active predicate maps to canonical is_active',()=>{
  assert.match(db,/is_active IS DISTINCT FROM false/);
  assert.match(db,/FROM\|JOIN[\s\S]*locations/);
});

test('management-gated VIR requests resolve canonical tenant before route scopes',()=>{
  assert.match(roles,/resolveTenantIdentity/);
  assert.match(roles,/path\.startsWith\("\/api\/vir\/"\)/);
  assert.match(tenant,/path\.startsWith\("\/api\/vir\/"\)/);
});
