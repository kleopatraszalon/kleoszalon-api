'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Release Control mounts the business integrity middleware on the backend route',()=>{
  const tx=read('src/routes/transactions.ts');
  assert.match(tx,/import \{enforceProcessIntegrityReleaseGate\} from "\.\.\/middleware\/releaseControlProcessIntegrity"/);
  assert.match(tx,/router\.use\("\/release-control",requireManagement,enforceProcessIntegrityReleaseGate,releaseControlRouter\)/);
});

test('process-integrity release gate is mandatory and fail-closed',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  for(const marker of ['business.process_integrity','Üzleti integritás','business_process_integrity_runs','__all__','blocking:true','editable:false'])assert.ok(src.includes(marker),marker);
  assert.ok(src.includes('status:passed?"pass":"fail"'));
  assert.ok(src.includes('String(row.status||"").toLowerCase()==="ok"&&exceptionCount===0'));
  assert.ok(src.includes('NO-GO: a folyamatintegritási release gate nem ellenőrizhető'));
  assert.ok(src.includes('nincs globális folyamatintegritási futás'));
});

test('Exception Command Center release gate blocks critical operational integrity cases only',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  for(const marker of ['business.exception_management','Exception Command Center release readiness','exception_cases','exception_case_events','exception_routing_rules','high_breached'])assert.ok(src.includes(marker),marker);
  for(const category of ['finance','nav','inventory','cashier','trace','system','process'])assert.ok(src.includes(`'${category}'`),category);
  assert.ok(src.includes('critical===0&&highBreached===0'));
  assert.ok(src.includes('exception_management_gate'));
});

test('Major Incident gate blocks SEV1 until post-mortem closure and active SEV2 or overdue critical actions',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  for(const marker of ['business.major_incident','Major Incident / War Room release readiness','major_incidents','major_incident_actions',"severity='sev1' AND status NOT IN('postmortem_closed','dismissed')","severity='sev2' AND status IN('open','mitigating','monitoring')",'overdue_critical_actions','major_incident_gate'])assert.ok(src.includes(marker),marker);
  assert.ok(src.includes('sev1===0&&sev2===0&&overdueActions===0'));
  assert.ok(src.includes('buildMajorIncidentReleaseGate()'));
});

test('backend middleware recomputes GO NO-GO and blockers after adding business integrity gates',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  assert.ok(src.includes('blockers=blocking.filter'));
  assert.ok(src.includes('release_ready:blockers.length===0'));
  assert.ok(src.includes('decision:blockers.length===0?"GO":"NO-GO"'));
  assert.ok(src.includes('blocking_open:blockers.length'));
  assert.ok(src.includes('process_integrity_gate'));
  assert.ok(src.includes('transaction_trace_gate'));
  assert.ok(src.includes('exception_management_gate'));
  assert.ok(src.includes('major_incident_gate'));
  assert.ok(src.includes('buildExceptionManagementReleaseGate()'));
  assert.ok(src.includes('buildMajorIncidentReleaseGate()'));
});
