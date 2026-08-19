const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const route=fs.readFileSync(path.join(process.cwd(),'src/routes/migrationCenter.ts'),'utf8');
const vir=fs.readFileSync(path.join(process.cwd(),'src/routes/vir.ts'),'utf8');
const sql=fs.readFileSync(path.join(process.cwd(),'src/sql/20260819_MIGRATION_CENTER_V18.sql'),'utf8');

test('v18 exposes all migration providers including intentionally duplicated Altegio',()=>{
  for(const provider of ['altegio','booksy','fresha','excel','csv']) {
    assert.ok(route.includes(`code:"${provider}"`),`missing migration provider: ${provider}`);
  }
  assert.ok(route.includes('name:"Altegio"'));
  assert.ok(route.includes('duplicate_visible:true'));
  assert.ok(route.includes('/api/services/import/altegio'));
  assert.ok(route.includes('/api/products/import/altegio'));
});

test('v18 supports staged preview mapping duplicate resolution audit and rollback',()=>{
  for(const policy of ['review','skip','merge','create_new']) assert.ok(route.includes(policy));
  for(const table of ['migration_runs','migration_items','migration_operations','migration_events']) {
    assert.ok(route.includes(table));
    assert.ok(sql.includes(table));
  }
  for(const endpoint of ['/runs/:id/upload','/runs/:id/mapping','/runs/:id/apply','/runs/:id/rollback','/runs/:id/evidence']) assert.ok(route.includes(endpoint));
});

test('v18 is tenant-admin scoped and fail-closed for untenantized SaaS targets',()=>{
  assert.ok(route.includes('requireAuth,requireTenantContext,requireTenantRole("owner","admin")'));
  assert.ok(route.includes('tenant_id'));
  assert.ok(route.includes('tenant-biztos'));
  assert.ok(route.includes('külső SaaS tenant importja blokkolva'));
});

test('v18 mounts as a dedicated VIR workspace while preserving legacy VIR routes',()=>{
  assert.ok(vir.includes('./migrationCenter'));
  assert.ok(vir.includes('./virLegacy'));
  assert.ok(vir.includes('/migration-center'));
});

test('appointments stay preview-only in v18 until relational resolvers are added',()=>{
  assert.ok(route.includes('appointments:{table:"appointments",apply:false'));
  assert.ok(route.includes('PREVIEW_ONLY_ENTITY'));
});
