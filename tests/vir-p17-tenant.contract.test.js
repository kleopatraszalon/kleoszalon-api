const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');
const p17=fs.readFileSync('src/routes/virP17.ts','utf8');
const tenant=fs.readFileSync('src/saas/tenantAccess.ts','utf8');
const migration=fs.readFileSync('src/migrations/20260831_001_vir_p17_autonomous_operations.sql','utf8');

test('VIR resolves canonical tenant before authenticated business routes',()=>{
  assert.ok(vir.includes('resolveTenantIdentity'));
  assert.ok(vir.includes('TENANT_CONTEXT_REQUIRED'));
  assert.ok(vir.indexOf('resolveTenantIdentity(req)')<vir.indexOf('router.use("/p1", virP1Router)'));
});

test('tenant identity is fail closed without Kleopatra or first-membership fallback',()=>{
  assert.ok(!tenant.includes("WHERE slug='kleopatra'"));
  assert.ok(tenant.includes('LIMIT 2'));
  assert.ok(tenant.includes('rows.length===1'));
  assert.ok(tenant.includes('locationRow&&String(locationRow.id)!==String(tokenRow.id)'));
});

test('P17 is mounted and uses canonical BIGINT tenant scope',()=>{
  assert.ok(vir.includes('router.use("/p17", virP17Router)'));
  assert.ok(p17.includes('tenant_id=$1::bigint'));
  assert.ok(!p17.includes('tenant_id=$1::uuid'));
  assert.ok(migration.includes('tenant_id bigint NOT NULL REFERENCES tenants(id)'));
});

test('P17 implements governed reversible workflow',()=>{
  for(const endpoint of ['/preview','/operations/:id/approve','/operations/:id/execute','/operations/:id/verify','/operations/:id/rollback'])assert.ok(p17.includes(endpoint),`missing ${endpoint}`);
  for(const state of ['pending_approval','approved','executed','verified','rolled_back'])assert.ok(p17.includes(state),`missing ${state}`);
  assert.ok(p17.includes('external_side_effects:false'));
});

test('P17 enforces tenant and location consistency twice',()=>{
  assert.ok(p17.includes('locationBelongsToTenant(value,tenant)'));
  assert.ok(migration.includes('vir_p17_enforce_location_tenant'));
  assert.ok(migration.includes('l.tenant_id=NEW.tenant_id'));
});
