const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const route=read('src/routes/migrationCenter.ts');
const vir=read('src/routes/vir.ts');
const sqlV18=read('src/sql/20260819_MIGRATION_CENTER_V18.sql');
const sqlV19=read('src/sql/20260819_MIGRATION_CENTER_V19_SCHEMA_WIDE.sql');

test('Migration Center keeps Altegio first-class and keeps native Altegio compatibility routes',()=>{
  assert.ok(route.includes('const PROVIDERS'));
  for(const provider of ['Altegio','Booksy','Fresha','Excel','CSV']) assert.ok(route.includes(provider),`missing provider: ${provider}`);
  assert.ok(route.includes('/api/services/import/altegio'));
  assert.ok(route.includes('/api/products/import/altegio'));
  assert.ok(route.includes('duplicate_visible: true'));
});

test('Migration Center exposes staging, duplicate handling, apply, rollback and evidence',()=>{
  for(const policy of ['review','skip','merge','create_new']) assert.ok(route.includes(policy),`missing duplicate policy: ${policy}`);
  for(const marker of ['upload.single("file")','/runs/:id/mapping','/runs/:id/apply','/runs/:id/rollback','/runs/:id/evidence']) assert.ok(route.includes(marker),`missing workflow marker: ${marker}`);
  for(const table of ['migration_runs','migration_items','migration_operations','migration_events']) {
    assert.ok(route.includes(table),`route missing ${table}`);
    assert.ok(sqlV18.includes(table),`v18 migration missing ${table}`);
  }
});

test('Migration Center is tenant-admin scoped and mounted on canonical VIR routing',()=>{
  assert.ok(route.includes('requireTenantContext'));
  assert.ok(route.includes('requireTenantRole("owner", "admin")'));
  assert.ok(route.includes('tenant_id'));
  assert.ok(vir.includes('migrationCenterRouter'));
  assert.ok(vir.includes('router.use("/migration-center", migrationCenterRouter)'));
  assert.ok(vir.includes('router.use(requireAuth)'));
});

test('v19 discovers the complete public VIR table catalog instead of five hard-coded entities',()=>{
  assert.ok(route.includes('information_schema.tables'));
  assert.ok(route.includes('table_type=\'BASE TABLE\''));
  assert.ok(route.includes('router.get("/catalog"'));
  assert.ok(route.includes('schema_version'));
  assert.ok(route.includes('const VERSION = 19'));
  assert.ok(sqlV19.includes('DROP CONSTRAINT IF EXISTS migration_runs_entity_type_check'));
  assert.ok(sqlV19.includes('schema_version'));
});

test('v19 allows relational appointment migration while retaining tenant/FK safety and rollback requirements',()=>{
  assert.ok(route.includes('appointments'));
  assert.ok(route.includes('client_id'));
  assert.ok(route.includes('employee_id'));
  assert.ok(route.includes('getForeignKeys'));
  assert.ok(route.includes('tenant_scoped'));
  assert.ok(route.includes('PREVIEW_ONLY_ENTITY'));
  assert.ok(route.includes('Elsődleges kulcs nélkül'));
});

test('v19 blocks direct import into authentication and migration-internal tables',()=>{
  for(const marker of ['/^migration_/i','/^users$/i','/^tenants$/i','/(^|_)sessions?$/i','/(^|_)api_keys?$/i']) assert.ok(route.includes(marker),`missing protection: ${marker}`);
  assert.ok(route.includes('Technikai vagy hitelesítési tábla'));
});
