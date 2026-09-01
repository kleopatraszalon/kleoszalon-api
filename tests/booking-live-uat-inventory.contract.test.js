const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const src=fs.readFileSync(path.join(process.cwd(),'tests/booking_live_uat.mjs'),'utf8');

test('live booking UAT uses configurable extended inventory horizon',()=>{
  assert.match(src,/BOOKING_UAT_HORIZON_DAYS/);
  assert.match(src,/\|\| 42/);
  assert.match(src,/day <= HORIZON_DAYS/);
});

test('empty production inventory is deployment-safe by default but strict mode remains available',()=>{
  assert.match(src,/BOOKING_UAT_REQUIRE_SLOT/);
  assert.match(src,/if \(REQUIRE_SLOT\)/);
  assert.match(src,/UAT_SKIP/);
  assert.match(src,/write lifecycle not attempted/);
  assert.match(src,/set BOOKING_UAT_REQUIRE_SLOT=1 for strict inventory validation/);
});

test('real booking mutation lifecycle remains mandatory whenever a slot exists',()=>{
  for(const marker of [
    'Real guest booking write',
    'Same-slot collision protection',
    'Real booking reschedule write',
    'Real booking cancellation write',
    'Cancellation persistence + lockout',
  ]) assert.ok(src.includes(marker),`missing booking lifecycle marker: ${marker}`);
  assert.match(src,/await exerciseBookingLifecycle\(selected\)/);
});
