const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const clients=read('src/routes/clients.ts');
const duplicate=read('src/routes/clientDuplicateReview.ts');
const formsFinal=read('src/routes/clientFormVersionsFinal.ts');
const forms=read('src/routes/clientFormVersions.ts');
const governance=read('src/routes/clientGovernance.ts');
const menu=read('src/menu/ensureMenuHealth.ts');

test('CRM finalization layers duplicate review and guarded versioned forms before core client routes',()=>{
  assert.match(clients,/clientDuplicateReviewRouter/);
  assert.match(clients,/clientFormVersionsFinalRouter/);
  assert.ok(clients.indexOf('router.use(clientDuplicateReviewRouter)')<clients.indexOf('router.use(clientsCoreRouter)'));
  assert.ok(clients.indexOf('router.use(clientFormVersionsFinalRouter)')<clients.indexOf('router.use(clientsCoreRouter)'));
  assert.match(formsFinal,/router\.use\(clientFormVersionsRouter\)/);
});

test('duplicate review uses canonical Stage16 transactional merge instead of a second merge implementation',()=>{
  assert.match(governance,/router.post\('\/duplicates\/merge-preview'/);
  assert.match(governance,/router.post\('\/duplicates\/merge'/);
  assert.match(governance,/client_merge_audit/);
  assert.match(duplicate,/duplicate-review\/merged/);
  assert.match(duplicate,/client_merge_audit/);
  assert.match(duplicate,/merged_into_client_id!==primaryId/);
  assert.doesNotMatch(duplicate,/DELETE FROM clients/i);
});

test('duplicate detection is scoped, approval protected and UUID-compatible with Stage16',()=>{
  assert.match(duplicate,/APPROVER_ROLES/);
  assert.match(duplicate,/telephely-hozzárendelés szükséges/);
  assert.match(duplicate,/a\.merged_into_client_id IS NULL AND b\.merged_into_client_id IS NULL/);
  assert.match(duplicate,/\$1::uuid IS NULL/);
  assert.match(duplicate,/crm_duplicate_resolutions/);
});

test('versioned forms retain immutable publication history and exact response snapshot',()=>{
  assert.match(forms,/CREATE TABLE IF NOT EXISTS crm_form_versions/);
  assert.match(forms,/status IN \('draft','published','retired'\)/);
  assert.match(forms,/UPDATE crm_form_versions SET status='retired'/);
  assert.match(forms,/form_version_id uuid/);
  assert.match(forms,/form_snapshot jsonb/);
  assert.match(forms,/privacy_notice_version: version\.privacy_notice_version/);
  assert.match(forms,/content_schema: version\.content_schema/);
});

test('CRM final menus expose forms and duplicate approval with explicit permissions',()=>{
  assert.match(menu,/customers\.forms/);
  assert.match(menu,/customers\.duplicate_review/);
  assert.match(menu,/Kérdőívek és nyilatkozatok/);
  assert.match(menu,/Duplikációk jóváhagyása/);
  assert.match(menu,/role_menu_permissions/);
});
