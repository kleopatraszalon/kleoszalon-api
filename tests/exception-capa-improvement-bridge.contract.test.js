const fs=require('fs');
const path=require('path');
const test=require('node:test');
const assert=require('node:assert/strict');

const read=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const route=read('src/routes/exceptionCommandCenter.ts');
const service=read('src/services/exceptionCapaImprovement.ts');

test('Exception CAPA bridge exposes an idempotent governed promote endpoint and link on detail',()=>{
  assert.ok(route.includes('/intelligence/capa/:id/promote'));
  assert.ok(route.includes('getExceptionCapaImprovementLink'));
  assert.ok(route.includes('promoteExceptionCapaToImprovement'));
  assert.ok(route.includes('locationBelongsToTenant'));
  assert.ok(service.includes('PRIMARY KEY(capa_id,tenant_id)'));
  assert.ok(service.includes('pg_advisory_xact_lock'));
  assert.ok(service.includes('created: false'));
});

test('Exception CAPA bridge requires prior human CAPA approval before project creation',()=>{
  assert.ok(service.includes('["approved", "in_progress", "verification", "verified"]'));
  assert.ok(service.includes('Fejlesztési projekt csak ember által jóváhagyott CAPA rekordból indítható.'));
  assert.ok(!service.includes('["proposed", "approved"'));
});

test('Exception CAPA bridge creates project corrective preventive KPI evidence and both audit trails',()=>{
  for(const marker of [
    'management_improvement_projects',
    "'active',CURRENT_DATE",
    '"corrective"',
    '"preventive"',
    "'exception_case_count'",
    'Exception CAPA forrásrekord',
    'exception_capa.promoted',
    'improvement_project_created',
    'exception_capa_improvement_links',
  ]) assert.ok(service.includes(marker),`missing marker: ${marker}`);
});

test('Exception CAPA bridge does not auto-approve the management improvement project',()=>{
  assert.ok(!service.includes("approval_state='approved'"));
  assert.ok(!service.includes("status='approved'"));
  assert.ok(service.includes("'active',CURRENT_DATE"));
});
