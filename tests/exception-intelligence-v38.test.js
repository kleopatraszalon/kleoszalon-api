'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Exception Intelligence persists escalation cluster snapshot and brief evidence',()=>{
  const src=read('src/services/exceptionCommandCenterIntelligence.ts');
  for(const marker of ['exception_escalation_rules','exception_case_escalations','exception_root_cause_clusters','exception_root_cause_cluster_cases','exception_intelligence_snapshots','exception_executive_brief_deliveries'])assert.ok(src.includes(marker),marker);
});

test('automatic escalation has three levels and ordered thresholds',()=>{
  const src=read('src/services/exceptionCommandCenterIntelligence.ts');
  for(const marker of ['level1_after_minutes','level2_after_minutes','level3_after_minutes','acknowledgement_overdue','sla_breached','executive_escalation'])assert.ok(src.includes(marker),marker);
  assert.ok(src.includes("('critical',15,30,60)"));
  assert.ok(src.includes('l1<l2&&l2<l3'));
});

test('root cause correlation covers trace entity outbreak and recurrence patterns',()=>{
  const src=read('src/services/exceptionCommandCenterIntelligence.ts');
  for(const marker of ['trace:', 'entity:', 'outbreak:', 'recurrence:', 'CAPA/root-cause', 'Azonos trace_id', 'Occurrence count >= 3'])assert.ok(src.includes(marker),marker);
});

test('intelligence dashboard measures trends operational response and recurrence',()=>{
  const src=read('src/services/exceptionCommandCenterIntelligence.ts');
  for(const marker of ['avg_ack_minutes','avg_resolution_minutes','sla_compliance_pct','recurrence_events','hotspots','health:{score','recommendations'])assert.ok(src.includes(marker),marker);
});

test('intelligence cycle and executive briefs are scheduled in Budapest timezone',()=>{
  const src=read('src/services/exceptionCommandCenterIntelligence.ts');
  assert.ok(src.includes('4-59/5 * * * *'));
  assert.ok(src.includes('0 8 * * *'));
  assert.ok(src.includes('30 19 * * *'));
  assert.ok(src.includes('Europe/Budapest'));
  assert.ok(src.includes('runExceptionIntelligenceCycle'));
  assert.ok(src.includes('sendExceptionExecutiveBrief'));
});

test('management API exposes intelligence dashboard run rules and brief controls',()=>{
  const route=read('src/routes/exceptionCommandCenter.ts');
  for(const marker of ['/intelligence/dashboard','/intelligence/run','/intelligence/escalation-rules','/intelligence/brief/:type','startExceptionCommandCenterIntelligenceScheduler'])assert.ok(route.includes(marker),marker);
});

test('analytics menu exposes Exception Intelligence to management only',()=>{
  const menu=read('src/services/executiveAiMenu.ts');
  assert.ok(menu.includes('analytics.exception_intelligence'));
  assert.ok(menu.includes('Exception Intelligence'));
  assert.ok(menu.includes('/finance/exception-command-center/intelligence'));
  assert.ok(menu.includes("NOT IN('admin','manager')"));
});
