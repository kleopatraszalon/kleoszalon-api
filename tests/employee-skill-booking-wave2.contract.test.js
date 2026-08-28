const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bookingRouter = fs.readFileSync(path.join(root, 'src/routes/onlineBooking.ts'), 'utf8');
const guard = fs.readFileSync(path.join(root, 'src/routes/onlineBookingSkillGuard.ts'), 'utf8');
const eligibility = fs.readFileSync(path.join(root, 'src/booking/employeeSkillEligibility.ts'), 'utf8');

test('VIR Wave II mounts skill guard before public booking handlers', () => {
  const guardPos = bookingRouter.indexOf('router.use(onlineBookingSkillGuardRouter)');
  const resourcesPos = bookingRouter.indexOf('router.use(onlineBookingResourcesRouter)');
  const corePos = bookingRouter.indexOf('router.use(onlineBookingCoreRouter)');
  assert.ok(guardPos >= 0, 'skill guard must be mounted');
  assert.ok(resourcesPos > guardPos, 'skill guard must run before booking resources');
  assert.ok(corePos > guardPos, 'skill guard must run before booking core');
});

test('VIR Wave II enforces can_perform and qualification expiry', () => {
  assert.match(eligibility, /COALESCE\(eo\.can_perform,true\)=true/);
  assert.match(eligibility, /qualification_valid_until IS NULL OR eo\.qualification_valid_until>=CURRENT_DATE/);
  assert.match(eligibility, /legacy_unrestricted/);
});

test('VIR Wave II blocks invalid direct booking and filters availability', () => {
  assert.match(guard, /EMPLOYEE_SKILL_NOT_ELIGIBLE/);
  assert.match(guard, /req\.path === "\/book"/);
  assert.match(guard, /req\.path === "\/availability"/);
  assert.match(guard, /removed_slots/);
});
