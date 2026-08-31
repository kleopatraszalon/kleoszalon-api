const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');
const lookups=fs.readFileSync('src/routes/virLookups.ts','utf8');

test('VIR resolves missing tenant context before downstream intelligence routes',()=>{
  assert.ok(vir.includes('resolveTenantIdentity'));
  assert.ok(vir.includes('if (!req.user?.tenant_id) await resolveTenantIdentity(req)'));
  assert.ok(vir.includes('router.use("/lookups", virLookupsRouter)'));
});

test('VIR lookups are tenant-scoped and searchable',()=>{
  for(const route of ["/context","/clients","/locations","/work-orders"]) assert.ok(lookups.includes(route),`missing ${route}`);
  assert.ok(lookups.includes('requireManagement'));
  assert.ok(lookups.includes('resolveTenantIdentity'));
  assert.ok(lookups.includes('a.tenant_id=$1::uuid'));
  assert.ok(lookups.includes('w.tenant_id=$1::uuid'));
  assert.ok(lookups.includes("ILIKE '%'||$2||'%'"));
});
