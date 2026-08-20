const fs = require('fs');
const assert = require('assert');

const backend = fs.readFileSync('src/routes/bookingSmartWaitlist.ts','utf8');
const mount = fs.readFileSync('src/routes/bookingOperations.ts','utf8');

assert.match(backend,/trg_capture_smart_waitlist_vacancy/);
assert.match(backend,/smart_waitlist_vacancies/);
assert.match(backend,/smart_waitlist_offers/);
assert.match(backend,/candidateRows/);
assert.match(backend,/score_breakdown/);
assert.match(backend,/accept_short_notice/);
assert.match(backend,/preferred_employee_id/);
assert.match(backend,/service_ids <@/);
assert.match(backend,/pg_advisory_xact_lock/);
assert.match(backend,/queueAppointmentCommunications/);
assert.match(backend,/detectComplexSource/);
assert.match(mount,/bookingSmartWaitlistRouter/);
assert.match(mount,/\/smart-waitlist/);

console.log('Smart Waitlist contract checks: OK');
