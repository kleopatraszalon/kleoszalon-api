const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('CAPA management watchdog persists idempotent escalation evidence',()=>{
  const src=read('src/services/exceptionCapaManagementWatchdog.ts');
  for(const marker of [
    'exception_capa_management_escalations',
    'UNIQUE(capa_id,cycle_key,escalation_level,recipient)',
    'ON CONFLICT(capa_id,cycle_key,escalation_level,recipient) DO NOTHING',
    'improvement_assignment_escalated',
    'last_management_notice_at',
  ])assert.ok(src.includes(marker),marker);
});

test('CAPA management watchdog reuses severity escalation policy and detects assignment or due-date breaches',()=>{
  const src=read('src/services/exceptionCapaManagementWatchdog.ts');
  for(const marker of [
    'exception_escalation_rules',
    'level1_after_minutes','level2_after_minutes','level3_after_minutes',
    'assignment_ack_overdue','unassigned_recommendation','suggested_due_overdue',
    "String(row.severity)==='critical'?3:2",
  ])assert.ok(src.includes(marker),marker);
});

test('CAPA management watchdog sends only to owner or tenant management recipients',()=>{
  const src=read('src/services/exceptionCapaManagementWatchdog.ts');
  assert.ok(src.includes('FROM tenant_users tu'));
  assert.ok(src.includes('WHERE tu.tenant_id=$1::bigint'));
  assert.ok(src.includes('assigned_owner_key'));
  assert.ok(!src.includes('getApmAdminRecipients'));
  assert.ok(!src.includes('APM_ADMIN_EMAILS'));
});

test('CAPA management watchdog scheduler is guarded and manual endpoint stays tenant-location scoped',()=>{
  const src=read('src/services/exceptionCapaManagementWatchdog.ts');
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  assert.ok(src.includes("cron.schedule('*/15 * * * *'"));
  assert.ok(src.includes("NODE_ENV==='test'"));
  assert.ok(src.includes("EXCEPTION_CENTER_DISABLED==='1'"));
  assert.ok(src.includes('rc.location_id::text = ANY($1::text[])'));
  assert.ok(route.includes('/intelligence/capa/improvement-workqueue/watchdog'));
  assert.ok(route.includes('runExceptionCapaManagementWatchdog(locations)'));
  assert.ok(route.includes('workqueueScope(req)'));
});
