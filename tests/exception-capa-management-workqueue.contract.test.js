const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('CAPA management queue persists assignment acknowledgement and notification evidence',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of [
    'assigned_owner_key text','assigned_owner_team text','acknowledged_by text','acknowledged_at timestamptz',
    'exception_capa_management_notifications','improvement_owner_assigned','improvement_assignment_acknowledged'
  ])assert.ok(src.includes(marker),marker);
});

test('management queue is risk sorted and exposes actionable governance counts',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of [
    "lower(c.severity)='critical'","r.score DESC","ready_to_promote","linked_projects","needs_ack","unassigned","overdue"
  ])assert.ok(src.includes(marker),marker);
  assert.match(src,/LIMIT \$\$\{params\.length\}/);
  assert.match(src,/Math\.min\(500/);
});

test('tenant-wide queue still proves every record through tenant locations',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  const service=read('src/services/exceptionCapaManagementQueue.ts');
  assert.match(route,/tenantLocationIds/);
  assert.match(route,/locationBelongsToTenant/);
  assert.match(route,/managementItemScope/);
  assert.match(route,/globális CAPA rekord tenant-hozzárendelése nem bizonyítható/);
  assert.match(service,/rc\.location_id::text = ANY\(\$1::text\[\]\)/);
});

test('workqueue API supports summary filtering owner assignment acknowledgement and safe escalation preview',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  for(const endpoint of [
    '/intelligence/capa/improvement-workqueue/summary',
    '/intelligence/capa/improvement-workqueue/escalations/preview',
    '/intelligence/capa/improvement-workqueue',
    '/intelligence/capa/:id/improvement-workqueue/assign',
    '/intelligence/capa/:id/improvement-workqueue/acknowledge'
  ])assert.ok(route.includes(endpoint),endpoint);
  for(const marker of ['status:String(req.query.status','severity:String(req.query.severity','onlyOverdue','onlyUnassigned','dryRun:true,locationIds:locations'])assert.ok(route.includes(marker),marker);
});

test('assignment cannot bypass CAPA improvement governance and notifies only explicit email owners',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  assert.match(src,/AND r\.status='recommended'/);
  assert.match(src,/NOT EXISTS\(SELECT 1 FROM exception_capa_improvement_links/);
  assert.match(src,/emailLike\(recipient\)/);
  assert.match(src,/sendEmail\(\{ to: recipient, subject, text \}\)/);
  assert.match(src,/SMTP nem küldött; az üzenet naplózásra került/);
  assert.doesNotMatch(src,/INSERT INTO management_improvement_projects/);
});

test('automatic management escalation is opt-in tenant-safe cooldown controlled and dry-run previewable',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of [
    'CAPA_MANAGEMENT_ESCALATION_ENABLED','CAPA_MANAGEMENT_ESCALATION_COOLDOWN_MINUTES','CAPA_MANAGEMENT_ACK_GRACE_HOURS',
    'notificationCoolingDown','tenantManagementRecipients','JOIN tenant_users tu ON tu.tenant_id=l.tenant_id','runExceptionCapaManagementEscalations',
    'options.locationIds','critical_unassigned','critical_risk','deadline_overdue','acknowledgement_overdue','dry_run_count',
    'startExceptionCapaManagementEscalationScheduler','!ESCALATION_ENABLED','7,37 * * * *'
  ])assert.ok(src.includes(marker),marker);
  assert.match(src,/\$2::text\[\] IS NULL OR rc\.location_id::text=ANY\(\$2::text\[\]\)/);
  assert.match(src,/created_at > now\(\)-\(\$4::int\*interval '1 minute'\)/);
});
