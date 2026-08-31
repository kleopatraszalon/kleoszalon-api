const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const hr = fs.readFileSync(path.join(root, 'src/hr/ensureHrV2.ts'), 'utf8');
const timetable = fs.readFileSync(path.join(root, 'src/routes/timetable.ts'), 'utf8');

test('HR runtime guarantees canonical employee fields required by schedule', () => {
  for (const column of ['full_name text', 'photo_url text', 'location_id uuid', 'position_id uuid', 'active boolean']) {
    assert.match(hr, new RegExp(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS ${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('legacy rows receive a safe display name before timetable reads them', () => {
  assert.match(hr, /SET full_name = COALESCE\(NULLIF\(btrim\(full_name\), ''\), NULLIF\(btrim\(login_name\), ''\), 'Munkatárs'\)/);
});

test('schedule awaits HR schema hardening before querying canonical employee fields', () => {
  const scheduleIndex = timetable.indexOf('router.get("/schedule"');
  const ensureIndex = timetable.indexOf('await ensureHrV2();', scheduleIndex);
  const employeeQueryIndex = timetable.indexOf('pool.query(`SELECT e.id,e.full_name,e.photo_url,e.location_id', scheduleIndex);
  assert.ok(scheduleIndex >= 0);
  assert.ok(ensureIndex > scheduleIndex);
  assert.ok(employeeQueryIndex > ensureIndex);
});
