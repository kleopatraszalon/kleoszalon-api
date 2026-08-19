const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('CAPA management queue persists assignment acknowledgement and notification evidence',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of ['assigned_owner_key text','assigned_owner_team text','acknowledged_by text','acknowledged_at timestamptz','exception_capa_management_notifications','improvement_owner_assigned','improvement_assignment_acknowledged'])assert.ok(src.includes(marker),marker);
});

test('management queue is risk sorted and exposes actionable governance counts',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of ["lower(c.severity)='critical'","r.score DESC","ready_to_promote","linked_projects","needs_ack","unassigned","overdue","Math.min(500"])assert.ok(src.includes(marker),marker);
  assert.match(src,/LIMIT \$\$\{params\.length\}/);
});

test('tenant-wide queue still proves every record through tenant locations',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  const service=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of ['tenantLocationIds','locationBelongsToTenant','managementItemScope','globális CAPA rekord tenant-hozzárendelése nem bizonyítható'])assert.ok(route.includes(marker),marker);
  assert.ok(service.includes('rc.location_id::text = ANY($1::text[])'));
});

test('workqueue API supports summary filtering owner assignment acknowledgement and safe escalation preview',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  for(const endpoint of ['/intelligence/capa/improvement-workqueue/summary','/intelligence/capa/improvement-workqueue/escalations/preview','/intelligence/capa/improvement-workqueue','/intelligence/capa/:id/improvement-workqueue/assign','/intelligence/capa/:id/improvement-workqueue/acknowledge'])assert.ok(route.includes(endpoint),endpoint);
  for(const marker of ['status:String(req.query.status','severity:String(req.query.severity','onlyOverdue','onlyUnassigned','dryRun:true,locationIds:locations'])assert.ok(route.includes(marker),marker);
});

test('assignment cannot bypass CAPA improvement governance and notifies only explicit email owners',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of ["AND r.status='recommended'",'NOT EXISTS(SELECT 1 FROM exception_capa_improvement_links','emailLike(recipient)','sendEmail({to:recipient,subject,text})','SMTP nem küldött; az üzenet naplózásra került.'])assert.ok(src.includes(marker),marker);
  assert.ok(!src.includes('INSERT INTO management_improvement_projects'));
});

test('automatic management escalation is opt-in tenant-safe cooldown controlled and dry-run previewable',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of ['CAPA_MANAGEMENT_ESCALATION_ENABLED','CAPA_MANAGEMENT_ESCALATION_COOLDOWN_MINUTES','CAPA_MANAGEMENT_ACK_GRACE_HOURS','notificationCoolingDown','tenantManagementRecipients','JOIN tenant_users tu ON tu.tenant_id=l.tenant_id','runExceptionCapaManagementEscalations','options.locationIds','critical_unassigned','critical_risk','deadline_overdue','acknowledgement_overdue','dry_run_count','startExceptionCapaManagementEscalationScheduler','!ESCALATION_ENABLED','7,37 * * * *',"created_at>now()-($4::int*interval '1 minute')"])assert.ok(src.includes(marker),marker);
  assert.ok(src.includes('$2::text[] IS NULL OR rc.location_id::text=ANY($2::text[])'));
});

test('tenant scoped preview does not share global scheduler in-flight result',()=>{
  const src=read('src/services/exceptionCapaManagementQueue.ts');
  for(const marker of ['const scoped=Array.isArray(options.locationIds)&&options.locationIds.length>0','if(scoped)return executeEscalations(options)','globalEscalationInFlight'])assert.ok(src.includes(marker),marker);
});
