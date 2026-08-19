const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const route=fs.readFileSync(path.join(process.cwd(),'src/routes/migrationCenter.ts'),'utf8');
const vir=fs.readFileSync(path.join(process.cwd(),'src/routes/vir.ts'),'utf8');
const sql=fs.readFileSync(path.join(process.cwd(),'src/sql/20260819_MIGRATION_CENTER_V18.sql'),'utf8');

test('v18 exposes all migration providers including intentionally duplicated Altegio',()=>{
  for(const provider of ['altegio','booksy','fresha','excel','csv']) assert.match(route,new RegExp(`code:["']${provider}["']`));
  assert.match(route,/name:"Altegio"/);
  assert.match(route,/duplicate_visible:true/);
  assert.match(route,/\/api\/services\/import\/altegio/);
  assert.match(route,/\/api\/products\/import\/altegio/);
});

test('v18 supports staged preview mapping duplicate resolution audit and rollback',()=>{
  for(const policy of ['review','skip','merge','create_new']) assert.match(route,new RegExp(policy));
  for(const table of ['migration_runs','migration_items','migration_operations','migration_events']) {
    assert.match(route,new RegExp(table));
    assert.match(sql,new RegExp(table));
  }
  assert.match(route,/\/runs\/:id\/upload/);
  assert.match(route,/\/runs\/:id\/mapping/);
  assert.match(route,/\/runs\/:id\/apply/);
  assert.match(route,/\/runs\/:id\/rollback/);
  assert.match(route,/\/runs\/:id\/evidence/);
});

test('v18 is tenant-admin scoped and fail-closed for untenantized SaaS targets',()=>{
  assert.match(route,/requireAuth,requireTenantContext,requireTenantRole\("owner","admin"\)/);
  assert.match(route,/tenant_id/);
  assert.match(route,/tenant-biztos/);
  assert.match(route,/külső SaaS tenant importja blokkolva/);
});

test('v18 mounts as a dedicated VIR workspace while preserving legacy VIR routes',()=>{
  assert.match(vir,/\.\/migrationCenter/);
  assert.match(vir,/\.\/virLegacy/);
  assert.match(vir,/\/migration-center/);
});

test('appointments stay preview-only in v18 until relational resolvers are added',()=>{
  assert.match(route,/appointments:\{table:"appointments",apply:false/);
  assert.match(route,/PREVIEW_ONLY_ENTITY/);
});
