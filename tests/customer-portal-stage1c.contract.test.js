const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('customer self-service is authenticated and customer-only',()=>{
  const src=read('src/routes/customerPortalSelfService.ts');
  assert.match(src,/router\.use\(requireAuth\)/);
  assert.match(src,/customer.*client.*guest/s);
  assert.match(src,/403/);
});

test('customer appointment mutations are ownership scoped and never hard-delete appointments',()=>{
  const src=read('src/routes/customerPortalSelfService.ts');
  assert.match(src,/WHERE id=\$1::uuid AND client_id=\$2::uuid FOR UPDATE/);
  assert.doesNotMatch(src,/DELETE\s+FROM\s+appointments/i);
  assert.match(src,/UPDATE appointments SET status='cancelled'/);
  assert.match(src,/customer_self_service_log/);
  assert.match(src,/appointment_change_log/);
});

test('customer reschedule rejects paid or locked work orders and revalidates availability',()=>{
  const src=read('src/routes/customerPortalSelfService.ts');
  assert.match(src,/locked_at\|\|wo\.archived_at/);
  assert.match(src,/work_order_payments/);
  assert.match(src,/minimum_notice_minutes/);
  assert.match(src,/booking_horizon_days/);
  assert.match(src,/work_shifts/);
  assert.match(src,/status='published'/);
  assert.match(src,/appointment_technical_breaks/);
  assert.match(src,/employee_service_overrides/);
});

test('profile self-service keeps email read-only and limits notification preference',()=>{
  const src=read('src/routes/customerPortalSelfService.ts');
  assert.match(src,/email_read_only:true/);
  assert.match(src,/\["email","sms","both"\]/);
  assert.doesNotMatch(src,/SET[^;]*email=/i);
});

test('stage 1c migration adds audit log and channel-aware communication uniqueness',()=>{
  const src=read('src/sql/20260810_CUSTOMER_PORTAL_STAGE1C.sql');
  assert.match(src,/customer_self_service_log/);
  assert.match(src,/email_channel_enabled/);
  assert.match(src,/sms_channel_enabled/);
  assert.match(src,/booking_communication_unique_event_channel_idx/);
  assert.match(src,/appointment_id,event_type,channel,scheduled_at/);
});

test('booking communications support both email and SMS adapters',()=>{
  const src=read('src/booking/communications.ts');
  const sms=read('src/sms.ts');
  assert.match(src,/sendEmail/);
  assert.match(src,/sendSms/);
  assert.match(src,/item\.channel==="email"/);
  assert.match(src,/item\.channel==="sms"/);
  assert.match(sms,/SMS_GATEWAY_URL/);
  assert.match(sms,/SMS_GATEWAY_TOKEN/);
});

test('customer portal bootstrap runs online booking and communication schemas before stage 1c',()=>{
  const src=read('src/customerPortal/ensureCustomerPortal.ts');
  const online=src.indexOf('await ensureOnlineBooking()');
  const comm=src.indexOf('20260807_BOOKING_COMMUNICATIONS_V1.sql');
  const stage=src.indexOf('20260810_CUSTOMER_PORTAL_STAGE1C.sql');
  assert.ok(online>=0&&comm>=0&&stage>comm,'stage 1c dependencies must be bootstrapped first');
});
