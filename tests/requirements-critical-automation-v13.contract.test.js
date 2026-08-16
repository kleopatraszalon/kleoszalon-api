'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('KLEO-FUN-BOOK-002-AC-01 online availability excludes past, booked and technical-break slots', () => {
  const src = read('src/routes/onlineBookingCore.ts');
  assert.match(src, /router\.get\("\/availability"/);
  assert.match(src, /minimum_notice_minutes/);
  assert.match(src, /booking_horizon_days/);
  assert.match(src, /status NOT IN \('cancelled','canceled','no_show'\)/);
  assert.match(src, /appointment_technical_breaks/);
  assert.match(src, /if \(end > to \|\| cursor < nowMin\) continue/);
  assert.match(src, /blocks\.some\(\(x: any\) => new Date\(x\.start_time\) < end && new Date\(x\.end_time\) > cursor\)/);
});

test('KLEO-FUN-BOOK-002-AC-02 online booking persists once and returns booking identity/status', () => {
  const src = read('src/routes/onlineBookingCore.ts');
  assert.match(src, /router\.post\("\/book"/);
  assert.match(src, /SELECT id FROM appointments[\s\S]*start_time<\$3::timestamptz AND end_time>\$2::timestamptz LIMIT 1/);
  assert.match(src, /return res\.status\(409\)\.json\(\{ error: "Ez az időpont időközben foglalttá vált/);
  assert.match(src, /INSERT INTO appointments\(employee_id,client_id,location_id,title,start_time,end_time,status/);
  assert.match(src, /await cx\.query\("COMMIT"\)/);
  assert.match(src, /res\.status\(201\)\.json\(\{ id: appointment\.rows\[0\]\.id, status/);
  assert.match(src, /persisted:true/);
  assert.match(src, /recovered:true/);
});

test('KLEO-FUN-WO-001-AC-01 a booking creates at most one linked work order with official number', () => {
  const src = read('src/services/bookingWorkOrder.ts');
  assert.match(src, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(src, /booking-workorder:\$\{appointmentId\}/);
  assert.match(src, /work_orders_appointment_uq/);
  assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS work_orders_appointment_uq ON work_orders\(appointment_id\)/);
  assert.match(src, /next_official_work_order_number/);
  assert.match(src, /if\(ap\.work_order_id\)/);
});

test('KLEO-FUN-WO-001-AC-02 invalid lifecycle transitions fail closed without direct completion', () => {
  const src = read('src/routes/workordersLifecycleHotfix.ts');
  assert.match(src, /const NEXT:Record<string,Set<string>>/);
  assert.match(src, /if\(requested==='completed'\)return res\.status\(409\)/);
  assert.match(src, /if\(!NEXT\[current\]\?\.has\(requested\)\)return res\.status\(409\)/);
  assert.match(src, /Nem engedélyezett státuszváltás/);
  assert.match(src, /if\(row\.locked_at\|\|row\.archived_at\)return res\.status\(409\)/);
});

test('KLEO-FUN-BOOK-004-AC-01 incomplete voice intent asks for clarification and does not create booking', () => {
  const src = read('src/routes/bookingVoice.ts');
  assert.match(src, /const missing:string\[\]=\[\]/);
  assert.match(src, /missing\.push\("location"\)/);
  assert.match(src, /missing\.push\("services"\)/);
  assert.match(src, /missing\.push\("date"\)/);
  assert.match(src, /function followUp\(/);
  assert.match(src, /Melyik Kleopátra szalonba szeretnél jönni/);
  assert.match(src, /Milyen szolgáltatást szeretnél foglalni/);
  assert.match(src, /Melyik nap lenne megfelelő/);
  assert.doesNotMatch(src, /router\.post\("\/interpret"[\s\S]*INSERT INTO appointments/);
});
