const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('src/routes/clientFormVersions.ts');
const server=read('src/server.ts');
const menu=read('src/menu/ensureMenuHealth.ts');

test('versioned forms router is mounted before generic clients routes',()=>{
  assert.match(server,/import clientFormVersionsRouter from"\.\/routes\/clientFormVersions"/);
  const versioned=server.indexOf('clientFormVersionsRouter');
  const generic=server.indexOf('clientsRouter',versioned+1);
  assert.ok(versioned>=0&&generic>versioned,'versioned forms router must be mounted before clientsRouter');
});

test('form versions have immutable published history and lifecycle metadata',()=>{
  assert.match(route,/CREATE TABLE IF NOT EXISTS crm_form_versions/);
  assert.match(route,/status text NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft','published','retired'\)\)/);
  assert.match(route,/effective_from timestamptz/);
  assert.match(route,/effective_to timestamptz/);
  assert.match(route,/UNIQUE\(form_id,version_no\)/);
  assert.match(route,/UPDATE crm_form_versions SET status='retired',effective_to=now\(\)/);
  assert.match(route,/UPDATE crm_form_versions SET status='published',effective_from=now\(\)/);
});

test('bootstrap updates current form version without target-table lateral reference',()=>{
  assert.match(route,/SELECT DISTINCT ON \(form_id\) form_id,id,version_no/);
  assert.match(route,/WHERE latest\.form_id=f\.id/);
  assert.doesNotMatch(route,/FROM LATERAL[\s\S]*v\.form_id=f\.id/);
});

test('question schema is normalized to supported field types',()=>{
  for(const type of ['text','textarea','yes_no','checkbox','select','date','number']) assert.match(route,new RegExp(`"${type}"`));
  assert.match(route,/fields: fields\.map/);
  assert.match(route,/required: Boolean/);
  assert.match(route,/options: Array\.isArray/);
});

test('completed responses keep exact form-version snapshot',()=>{
  assert.match(route,/ALTER TABLE IF EXISTS crm_form_responses ADD COLUMN IF NOT EXISTS form_version_id uuid/);
  assert.match(route,/ALTER TABLE IF EXISTS crm_form_responses ADD COLUMN IF NOT EXISTS form_version_no integer/);
  assert.match(route,/ALTER TABLE IF EXISTS crm_form_responses ADD COLUMN IF NOT EXISTS form_snapshot jsonb/);
  assert.match(route,/INSERT INTO crm_form_responses\(form_id,client_id,status,response_data,completed_at,form_version_id,form_version_no,form_snapshot\)/);
  assert.match(route,/privacy_notice_version: version\.privacy_notice_version/);
  assert.match(route,/content_schema: version\.content_schema/);
});

test('editing and publishing is management-only and draft-only',()=>{
  assert.match(route,/EDITOR_ROLES = new Set\(\["admin", "manager", "location_manager", "salon_manager"\]\)/);
  assert.match(route,/if \(!canEdit\(req\)\)/);
  assert.match(route,/if \(current\[0\]\.status !== "draft"\)/);
  assert.match(route,/Csak tervezet állapotú verzió tehető közzé/);
});

test('versioned forms menu stays active and points to the dedicated workspace',()=>{
  assert.match(menu,/customers\.forms/);
  assert.match(menu,/Kérdőívek és nyilatkozatok/);
  assert.match(menu,/\/modules\/customers\/forms/);
  assert.match(menu,/WHERE m\.code IN\('customers\.forms','customers\.duplicate_review'\)/);
});
