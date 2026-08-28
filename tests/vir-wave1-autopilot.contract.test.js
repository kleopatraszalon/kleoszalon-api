const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'src/booking/virWave1Engine.ts'), 'utf8');
const api = fs.readFileSync(path.join(root, 'src/routes/bookingV4Autopilot.ts'), 'utf8');
const bookingRisk = fs.readFileSync(path.join(root, 'src/routes/onlineBookingWave1Risk.ts'), 'utf8');
const bookingRouter = fs.readFileSync(path.join(root, 'src/routes/onlineBooking.ts'), 'utf8');
const automationRouter = fs.readFileSync(path.join(root, 'src/routes/bookingV4Automation.ts'), 'utf8');

test('VIR Wave I contains all four roadmap pillars', () => {
  assert.match(engine, /findCalendarGaps/);
  assert.match(engine, /matchWaitlist/);
  assert.match(engine, /calculateClientNoShowRisk/);
  assert.match(engine, /dynamicDepositDecision/);
  assert.match(engine, /rebookingCandidates/);
  assert.match(engine, /churn_score/);
});

test('VIR Wave I exposes Autopilot preview, prepare and approve-all workflow', () => {
  assert.match(api, /router\.get\("\/preview"/);
  assert.match(api, /router\.post\("\/prepare"/);
  assert.match(api, /router\.post\("\/approve-all"/);
  assert.match(automationRouter, /router\.use\("\/autopilot", bookingV4AutopilotRouter\)/);
});

test('VIR Wave I persists no-show scores, deposits and waitlist matches', () => {
  assert.match(engine, /CREATE TABLE IF NOT EXISTS booking_no_show_scores/);
  assert.match(engine, /CREATE TABLE IF NOT EXISTS booking_deposit_requirements/);
  assert.match(engine, /CREATE TABLE IF NOT EXISTS booking_waitlist_matches/);
  assert.match(engine, /CREATE TABLE IF NOT EXISTS vir_autopilot_runs/);
});

test('VIR Wave I online booking risk middleware is fail-soft and mounted before booking core', () => {
  const riskPos = bookingRouter.indexOf('router.use(onlineBookingWave1RiskRouter)');
  const corePos = bookingRouter.indexOf('router.use(onlineBookingCoreRouter)');
  assert.ok(riskPos >= 0 && corePos > riskPos);
  assert.match(bookingRisk, /return next\(\)/);
  assert.match(bookingRisk, /deposit_recommended/);
  assert.match(bookingRisk, /automation_mode/);
});

test('VIR Wave I AI affects messaging, not deterministic risk score', () => {
  const riskFunction = engine.slice(engine.indexOf('export async function calculateClientNoShowRisk'), engine.indexOf('export function dynamicDepositDecision'));
  assert.doesNotMatch(riskFunction, /OPENAI_API_KEY/);
  assert.match(engine, /rebooking AI fallback/);
  assert.match(engine, /ai_used/);
});
