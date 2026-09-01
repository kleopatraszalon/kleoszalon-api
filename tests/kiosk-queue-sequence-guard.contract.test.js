const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'migrations', '20260901_002_kiosk_queue_sequence_guard.sql'),
  'utf8',
);

test('kiosk queue allocator cannot return a number below persisted work orders', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION guard_kiosk_daily_queue_sequence\(\)/);
  assert.match(migration, /MAX\(w\.kiosk_queue_no\)/);
  assert.match(migration, /NEW\.last_value\s*:=\s*GREATEST/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF last_value ON kiosk_daily_queue_sequences/);
});

test('hotfix keeps the Budapest-local active kiosk backfill', () => {
  assert.match(migration, /timezone\('Europe\/Budapest', now\(\)\)::date/);
  assert.match(migration, /status IN \('waiting', 'arrived', 'in_progress'\)/);
  assert.match(migration, /kiosk_queue_code = 'KIOSK'/);
});
