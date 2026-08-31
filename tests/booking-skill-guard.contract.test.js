const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const schedule = fs.readFileSync(path.join(root, 'src/routes/bookingSchedule.ts'), 'utf8');
const eligibility = fs.readFileSync(path.join(root, 'src/booking/employeeSkillEligibility.ts'), 'utf8');

test('availability excludes disabled and expired employee skill rows', () => {
  assert.match(schedule, /COALESCE\(eo\.can_perform,true\)=true/);
  assert.match(schedule, /qualification_valid_until IS NULL OR eo\.qualification_valid_until>=CURRENT_DATE/);
});

test('direct booking is rejected by the same skill authority', () => {
  assert.match(schedule, /employeeSkillEligibility\(db,employeeId,serviceIds\)/);
  assert.match(schedule, /EMPLOYEE_SKILL_NOT_ELIGIBLE/);
});

test('qualification expiry is evaluated in SQL and UUIDs are normalized', () => {
  assert.match(eligibility, /qualification_valid_until < CURRENT_DATE/);
  assert.match(eligibility, /trim\(\)\.toLowerCase\(\)/);
  assert.doesNotMatch(eligibility, /String\(row\.qualification_valid_until\)\.slice/);
});

test('legacy employees without configured overrides remain compatible', () => {
  assert.match(eligibility, /legacy_unrestricted/);
  assert.match(eligibility, /if \(!configured\.rows\[0\]\?\.configured\)/);
});
