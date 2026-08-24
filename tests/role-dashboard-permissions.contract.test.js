const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');

const sql=fs.readFileSync('src/migrations/20260824_002_role_dashboard_permissions.sql','utf8');

test('every internal occupational role receives a scoped dashboard capability',()=>{
  for(const role of ['manager','hr_manager','accounting','location_manager','salon_manager','receptionist','employee']){
    assert.ok(sql.includes(`('${role}'`),`${role} dashboard scope is missing`);
  }
  assert.match(sql,/feature_key,can_use,scope_type[\s\S]*'management_dashboard',true/);
});

test('dashboard repair grants read-only menu access without financial or admin escalation',()=>{
  assert.match(sql,/m\.code='dashboard'/);
  assert.match(sql,/SELECT r\.role_key,m\.id,true,false,false,false,false,false,false,false/);
  assert.doesNotMatch(sql,/m\.code='analytics(?:\.main)?'/);
});
