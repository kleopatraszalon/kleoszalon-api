const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('finance NAV bootstrap creates RBAC core before fail-closed migration',()=>{
  const src=read('src/finance/ensureFinanceNav.ts');
  const helper=src.indexOf('async function ensureRbacBootstrapPrerequisites()');
  const helperCall=src.indexOf("await step('rbac_core_schema',()=>ensureRbacBootstrapPrerequisites())");
  const failClosed=src.indexOf("await step('sql:20260810_RBAC_FAIL_CLOSED_V1.sql'");
  assert.ok(helper>=0,'RBAC prerequisite helper must exist');
  assert.ok(helperCall>=0 && failClosed>helperCall,'RBAC core schema must be ensured before fail-closed SQL');
  for(const table of ['access_roles','role_menu_permissions','role_feature_permissions']){
    assert.match(src,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test('accounting user RBAC is skipped only when users relation is absent',()=>{
  const src=read('src/finance/ensureFinanceNav.ts');
  assert.match(src,/if\(await relationExists\('users'\)\)/);
  assert.match(src,/20260814_ACCOUNTING_USER_RBAC_V1\.sql/);
  assert.match(src,/accounting user RBAC skipped: users relation is not present/);
});
