const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const route=read('src/routes/migrationCenter.ts');
const vir=read('src/routes/vir.ts');
const sql=read('src/sql/20260819_MIGRATION_CENTER_V18.sql');

test('Migration Center v18 keeps Altegio first-class and keeps native Altegio compatibility routes',()=>{
  assert.ok(route.includes('const PROVIDERS'));
  for(const provider of ['Altegio','Booksy','Fresha','Excel','CSV']) assert.ok(route.includes(provider),`missing provider: ${provider}`);
  assert.ok(route.includes('/api/services/import/altegio'));
  assert.ok(route.includes('/api/products/import/altegio'));
  assert.ok(route.includes('duplicate_visible:true'));
});

test('Migration Center v18 exposes staging, duplicate handling, apply, rollback and evidence',()=>{
  for(const policy of ['review','skip','merge','create_new']) assert.ok(route.includes(policy),`missing duplicate policy: ${policy}`);
  for(const marker of ['upload.single("file")','/runs/:id/mapping','/runs/:id/apply','/runs/:id/rollback','/runs/:id/evidence']) assert.ok(route.includes(marker),`missing workflow marker: ${marker}`);
  for(const table of ['migration_runs','migration_items','migration_operations','migration_events']) {
    assert.ok(route.includes(table),`route missing ${table}`);
    assert.ok(sql.includes(table),`migration missing ${table}`);
  }
});

test('Migration Center v18 is tenant-admin scoped and mounted without removing legacy VIR routes',()=>{
  assert.ok(route.includes('requireTenantContext'));
  assert.ok(route.includes('requireTenantRole("owner","admin")'));
  assert.ok(route.includes('tenant_id'));
  assert.ok(vir.includes('migrationCenterRouter'));
  assert.ok(vir.includes('legacyVirRouter'));
  assert.ok(vir.includes('/migration-center'));
});

test('appointments remain preview-only until relational resolution is implemented',()=>{
  assert.ok(route.includes('appointments'));
  assert.ok(route.includes('apply:false'));
  assert.ok(route.includes('PREVIEW_ONLY_ENTITY'));
});
