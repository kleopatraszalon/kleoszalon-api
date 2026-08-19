const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const service=read('src/services/nbaRevenueAttribution.ts');
const publicRoute=read('src/routes/onlineBookingNbaAttribution.ts');
const onlineBooking=read('src/routes/onlineBooking.ts');
const admin=read('src/routes/nbaAttributionAdmin.ts');
const clients=read('src/routes/clients.ts');
const sql=read('src/sql/20260819_NBA_REVENUE_ATTRIBUTION_V21.sql');

test('public booking router exposes opaque NBA touch and attribution endpoints',()=>{
  assert.ok(onlineBooking.includes('onlineBookingNbaAttributionRouter'));
  assert.ok(onlineBooking.includes('router.use(onlineBookingNbaAttributionRouter)'));
  assert.ok(publicRoute.includes('/nba/touch'));
  assert.ok(publicRoute.includes('/nba/attribute'));
  assert.ok(publicRoute.includes('never return customer/job details')||publicRoute.includes('never return CRM'));
});

test('booking attribution is fail closed on job, window, creation time, client and appointment state',()=>{
  for(const marker of ['JOB_NOT_TRACKABLE','ATTRIBUTION_WINDOW_EXPIRED','APPOINTMENT_PRECEDES_CAMPAIGN','CLIENT_MISMATCH','APPOINTMENT_NOT_CONVERTED'])assert.ok(service.includes(marker),marker);
  assert.ok(service.includes('appointmentCreatedAt<sentAt'));
  assert.ok(service.includes('String(appointment.client_id)!==String(job.client_id)'));
  assert.ok(service.includes('30*86400000'));
});

test('landing dedupe is deterministic and stores no raw IP',()=>{
  assert.ok(service.includes('sha256'));
  assert.ok(service.includes('hour.toISOString()'));
  assert.ok(sql.includes('crm_nba_marketing_touches_dedupe_uq'));
  assert.ok(sql.includes('(job_id,fingerprint_hash)'));
  assert.ok(!service.includes('req.ip'));
});

test('revenue is grounded in persisted work order payments and excludes cancelled/no-show bookings',()=>{
  assert.ok(service.includes('work_order_payments'));
  assert.ok(service.includes("NOT IN('cancelled','canceled','no_show')"));
  assert.ok(service.includes('paid_revenue'));
  assert.ok(service.includes('revenue_per_send'));
  assert.ok(service.includes('attr_job'));
  assert.ok(service.includes('paid_job'));
});

test('admin analytics is tenant and location scoped with a matching location denominator',()=>{
  assert.ok(admin.includes('requireTenantContext'));
  assert.ok(admin.includes('LOCATION_SCOPE_REQUIRED'));
  assert.ok(admin.includes('applyLocationDenominator'));
  assert.ok(admin.includes('WITH scoped_jobs AS'));
  assert.ok(admin.includes("(to_jsonb(c)->>'location_id')=$3::text"));
  assert.ok(admin.includes('summary.sent_jobs=sent'));
  assert.ok(admin.includes('summary.landed_jobs='));
  assert.ok(admin.includes('summary.conversion_rate_percent='));
  assert.ok(clients.includes("router.use('/intelligence/attribution',nbaAttributionAdminRouter)"));
  assert.ok(clients.indexOf("'/intelligence/attribution'")<clients.indexOf("'/intelligence'"));
});
