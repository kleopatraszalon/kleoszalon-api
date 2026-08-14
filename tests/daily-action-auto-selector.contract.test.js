const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const selector = fs.readFileSync(path.join(__dirname, '../src/routes/dailyActionAutoSelector.ts'), 'utf8');
const transactions = fs.readFileSync(path.join(__dirname, '../src/routes/transactions.ts'), 'utf8');

test('automatic daily action selector is manager protected and opt-in by service', () => {
  assert.match(transactions, /daily-actions\/auto-selector/);
  assert.match(transactions, /requireManagement\s*,\s*dailyActionAutoSelectorRouter/);
  assert.match(selector, /daily_action_enabled boolean NOT NULL DEFAULT false/);
  assert.match(selector, /COALESCE\(daily_action_enabled,false\)=true/);
  assert.match(selector, /PATCH|router\.patch\("\/service\/:serviceId\/eligibility"/i);
});

test('selector ranks real booking demand and scheduled capacity', () => {
  assert.match(selector, /appointment_services/);
  assert.match(selector, /work_shifts/);
  assert.match(selector, /HISTORY_DAYS = 28/);
  assert.match(selector, /RECENT_CAMPAIGN_DAYS = 14/);
  assert.match(selector, /locationOccupancyPct/);
  assert.match(selector, /demandGapPct/);
  assert.match(selector, /recentPenalty/);
});

test('AI is copy support only and cannot auto publish campaigns', () => {
  assert.match(selector, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(selector, /Ne találj ki árat, kedvezményt/);
  assert.match(selector, /deterministicCopy/);
  assert.match(selector, /status,service_id,auto_selector_meta/);
  assert.match(selector, /'draft'/);
  assert.doesNotMatch(selector, /status\s*=\s*['"]published['"]/);
  assert.doesNotMatch(selector, /\/publish["'`]/);
});

test('generated campaign keeps auditable selector metadata', () => {
  assert.match(selector, /algorithm:\s*"occupancy-service-demand-v1"/);
  assert.match(selector, /suggested_discount_pct/);
  assert.match(selector, /applied_discount_pct/);
  assert.match(selector, /avg_daily_bookings_28d/);
  assert.match(selector, /location_occupancy_pct/);
  assert.match(selector, /ai_mode/);
});
