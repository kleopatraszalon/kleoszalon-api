const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'migrations', '20260901_003_kiosk_workorder_runtime_guard.sql'),
  'utf8',
);

test('public kiosk workorder dependencies are bootstrapped idempotently', () => {
  assert.match(sql, /ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS source text/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS work_order_items/);
  assert.match(sql, /ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_snapshot jsonb/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS work_order_number_sequences/);
});

test('official workorder numbering self-heals against persisted numbers', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION next_official_work_order_number/);
  assert.match(sql, /MAX\(NULLIF\(substring\(work_order_number/);
  assert.match(sql, /GREATEST\(work_order_number_sequences\.last_value \+ 1, EXCLUDED\.last_value\)/);
});

test('kiosk daily numbering self-heals before unique workorder insert', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION next_kiosk_daily_queue/);
  assert.match(sql, /COALESCE\(MAX\(kiosk_queue_no\), 0\) \+ 1/);
  assert.match(sql, /GREATEST\(kiosk_daily_queue_sequences\.last_value \+ 1, EXCLUDED\.last_value\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS work_orders_kiosk_queue_uq/);
  assert.match(sql, /CREATE TRIGGER trg_assign_kiosk_daily_queue/);
});
