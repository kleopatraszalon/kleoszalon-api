const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'migrations', '20260901_003_kiosk_queue_insert_guard.sql'),
  'utf8',
);

test('kiosk work-order insert is serialized per salon and Budapest business day', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION assign_kiosk_daily_queue_safe\(\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /MAX\(w\.kiosk_queue_no\)/);
  assert.match(sql, /timezone\('Europe\/Budapest'/);
});

test('safe trigger runs before the legacy queue trigger and keeps sequence compatibility', () => {
  assert.match(sql, /CREATE TRIGGER trg_00_kiosk_daily_queue_safe/);
  assert.match(sql, /NEW\.kiosk_queue_no IS NULL/);
  assert.match(sql, /GREATEST\(kiosk_daily_queue_sequences\.last_value, EXCLUDED\.last_value\)/);
  assert.match(sql, /WHEN n < 1000 THEN lpad\(n::text, 3, '0'\)/);
});
