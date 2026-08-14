const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const clients=read('src/routes/clients.ts');
const guard=read('src/routes/clientFormVersionsFinal.ts');
const forms=read('src/routes/clientFormVersions.ts');
const duplicate=read('src/routes/clientDuplicateReview.ts');

test('CRM versioned forms use the final role-normalizing guard',()=>{
  assert.match(clients,/clientFormVersionsFinalRouter/);
  assert.match(clients,/router\.use\(clientFormVersionsFinalRouter\)/);
  assert.doesNotMatch(clients,/router\.use\(clientFormVersionsRouter\)/);
  assert.match(guard,/router\.use\(requireAuth\)/);
  assert.match(guard,/router\.use\(normalizeClientFormRoles\)/);
  assert.match(guard,/router\.use\(clientFormVersionsRouter\)/);
});

test('CRM form editor role aliases match governance-approved management roles',()=>{
  for(const alias of ['administrator','rendszergazda','superadmin','super_admin']) assert.match(guard,new RegExp(alias));
  for(const alias of ['üzletvezető','uzletvezeto','store_manager','branch_manager']) assert.match(guard,new RegExp(alias));
  for(const alias of ['szalonvezető','szalonvezeto']) assert.match(guard,new RegExp(alias));
  assert.match(guard,/return "admin"/);
  assert.match(guard,/return "location_manager"/);
  assert.match(guard,/return "salon_manager"/);
  assert.match(forms,/EDITOR_ROLES/);
});

test('duplicate approval and form editing share management role coverage',()=>{
  assert.match(duplicate,/APPROVER_ROLES/);
  assert.match(duplicate,/szalonvezető/);
  assert.match(duplicate,/üzletvezető/);
  assert.match(guard,/szalonvezető/);
  assert.match(guard,/üzletvezető/);
});
