const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('CAPA management escalation is opt-in, cooldown controlled and tenant scoped',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of [
    'CAPA_MANAGEMENT_ESCALATION_ENABLED',
    'CAPA_MANAGEMENT_ESCALATION_COOLDOWN_MINUTES',
    'CAPA_MANAGEMENT_ACK_GRACE_HOURS',
    'notificationCoolingDown',
    'tenantManagementRecipients',
    'JOIN tenant_users tu ON tu.tenant_id=l.tenant_id',
    'runExceptionCapaManagementEscalations',
    'options.locationIds',
    'critical_unassigned',
    'critical_risk',
    'deadline_overdue',
    'acknowledgement_overdue',
    'startExceptionCapaManagementEscalationScheduler',
    '!ESCALATION_ENABLED',
    '7,37 * * * *'
  ])assert.ok(src.includes(marker),marker);
  assert.match(src,/\$2::text\[\]\s+IS\s+NULL\s+OR\s+rc\.location_id::text\s*=\s*ANY\(\$2::text\[\]\)/);
});

test('tenant scoped dry-run preview is exposed and isolated from global scheduler result',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  assert.ok(route.includes('/intelligence/capa/improvement-workqueue/escalations/preview'));
  assert.match(route,/runExceptionCapaManagementEscalations\(\{\s*dryRun\s*:\s*true\s*,\s*locationIds\s*:\s*locations\s*\}\)/);
  assert.match(src,/if\s*\(scoped\)\s*return\s+executeEscalations\(options\)/);
  assert.ok(src.includes('globalEscalationInFlight'));
});

test('CAPA management workqueue is limited to management roles and later executive controls are retained',()=>{
  const menu=read('src/services/executiveAiMenu.ts');
  for(const marker of [
    "'analytics.capa_workqueue','CAPA vezetői munkasor'",
    "(VALUES('admin'),('manager'))",
    "'analytics.business_continuity_gameday'",
    "'analytics.operational_risk'"
  ])assert.ok(menu.includes(marker),marker);
  assert.ok(menu.includes("lower(p.role_key) NOT IN('admin','manager')"));
});
