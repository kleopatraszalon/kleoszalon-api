const fs=require('fs');
const path=require('path');

const read=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

describe('Exception CAPA -> management improvement bridge',()=>{
  const route=read('src/routes/exceptionCommandCenter.ts');
  const service=read('src/services/exceptionCapaImprovement.ts');

  test('exposes an idempotent governed promote endpoint and link on detail',()=>{
    expect(route).toContain('/intelligence/capa/:id/promote');
    expect(route).toContain('getExceptionCapaImprovementLink');
    expect(route).toContain('promoteExceptionCapaToImprovement');
    expect(route).toContain('locationBelongsToTenant');
    expect(service).toContain('PRIMARY KEY(capa_id,tenant_id)');
    expect(service).toContain('created: false');
  });

  test('requires prior human CAPA approval before project creation',()=>{
    expect(service).toContain('["approved", "in_progress", "verification", "verified"]');
    expect(service).toContain('Fejlesztési projekt csak ember által jóváhagyott CAPA rekordból indítható.');
    expect(service).not.toContain('["proposed", "approved"');
  });

  test('creates project corrective preventive KPI evidence and both audit trails',()=>{
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
    ])expect(service).toContain(marker);
  });

  test('does not auto-approve the management improvement project',()=>{
    expect(service).not.toContain("approval_state='approved'");
    expect(service).not.toContain("status='approved'");
    expect(service).toContain("'active',CURRENT_DATE");
  });
});
