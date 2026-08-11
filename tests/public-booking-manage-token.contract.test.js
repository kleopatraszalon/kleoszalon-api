const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('public marketing mounts token booking management before generic booking router',()=>{
  const src=read('src/routes/publicMarketing.ts');
  assert.match(src,/bookingManageRouter/);
  assert.match(src,/router\.use\("\/booking\/manage",\s*bookingManageRouter\)/);
  assert.ok(src.indexOf('/booking/manage')<src.indexOf('onlineBookingRouter'));
});

test('management token reveals only booking summary and scopes lookup by cancellation token',()=>{
  const src=read('src/routes/bookingManage.ts');
  assert.match(src,/WHERE a\.cancellation_token=\$1::uuid/);
  assert.match(src,/management_token_valid:true/);
  assert.match(src,/service_ids/);
  assert.doesNotMatch(src,/c\.email/);
  assert.doesNotMatch(src,/c\.phone/);
});

test('public token reschedule revalidates all operational guards',()=>{
  const src=read('src/routes/bookingManage.ts');
  assert.match(src,/assertMutableWorkOrder/);
  assert.match(src,/minimum_notice_minutes/);
  assert.match(src,/booking_horizon_days/);
  assert.match(src,/employee_service_overrides/);
  assert.match(src,/status='published'/);
  assert.match(src,/work_shifts/);
  assert.match(src,/id<>\$1::uuid/);
  assert.match(src,/appointment_technical_breaks/);
  assert.match(src,/public_rescheduled/);
  assert.match(src,/queueAppointmentCommunications\(String\(updated\.id\),"rescheduled"\)/);
});

test('public token cancellation is work-order and payment safe',()=>{
  const src=read('src/routes/bookingManage.ts');
  assert.match(src,/public_cancelled/);
  assert.match(src,/work_order_payments/);
  assert.match(src,/financial_closed_at/);
  assert.match(src,/UPDATE appointments SET status='cancelled'/);
  assert.match(src,/queueAppointmentCommunications\(String\(updated\.id\),"cancelled"\)/);
});

test('booking communications link to branded public management page',()=>{
  const src=read('src/booking/communications.ts');
  assert.match(src,/PUBLIC_BOOKING_URL/);
  assert.match(src,/\/booking\/manage\/\$\{a\.cancellation_token\}/);
  assert.match(src,/Foglalás kezelése \(módosítás \/ lemondás\)/);
  assert.doesNotMatch(src,/\/booking\/cancel\/\$\{a\.cancellation_token\}/);
});
