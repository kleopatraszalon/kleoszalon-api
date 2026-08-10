const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('availability can exclude the appointment being rescheduled without weakening booking conflict checks',()=>{
  const schedule=read('src/routes/bookingSchedule.ts');
  const self=read('src/routes/customerPortalSelfService.ts');
  assert.match(schedule,/exclude_appointment_id/);
  assert.match(schedule,/\(\$5::uuid IS NULL OR id<>\$5::uuid\)/);
  assert.match(schedule,/excludes_current_appointment/);
  assert.match(self,/WHERE id<>\$1::uuid AND employee_id=\$2::uuid/);
});

test('published shift availability is authoritative once a location has a published schedule for the date',()=>{
  const schedule=read('src/routes/bookingSchedule.ts');
  assert.match(schedule,/publishedCount/);
  assert.match(schedule,/publishedCount<=0/);
  assert.match(schedule,/source:"published_shifts"/);
  assert.match(schedule,/const map=new Map<string,Interval\[]>\(\)/);
  assert.match(schedule,/schedule\.map\.get\(id\)\|\|\[\]/);
});

test('disabled or log-only communication providers terminate as suppressed instead of recycling forever',()=>{
  const worker=read('src/booking/communications.ts');
  const migration=read('src/sql/20260810_BOOKING_COMMUNICATIONS_RETRY_V1.sql');
  assert.match(worker,/result\?\.logged/);
  assert.match(worker,/status='suppressed'/);
  assert.doesNotMatch(worker,/result\?\.logged[\s\S]{0,350}status='pending'/);
  assert.match(migration,/suppressed/);
});

test('communication transport errors retry finitely with backoff then fail terminally',()=>{
  const worker=read('src/booking/communications.ts');
  assert.match(worker,/MAX_SEND_ATTEMPTS=3/);
  assert.match(worker,/retryDelayMinutes/);
  assert.match(worker,/attempt<MAX_SEND_ATTEMPTS/);
  assert.match(worker,/retry_scheduled/);
  assert.match(worker,/status='failed'/);
});

test('customer portal bootstrap installs retry queue migration after stage1c',()=>{
  const src=read('src/customerPortal/ensureCustomerPortal.ts');
  const stage=src.indexOf('20260810_CUSTOMER_PORTAL_STAGE1C.sql');
  const retry=src.indexOf('20260810_BOOKING_COMMUNICATIONS_RETRY_V1.sql');
  assert.ok(stage>=0&&retry>stage,'retry migration must run after stage 1c');
});
