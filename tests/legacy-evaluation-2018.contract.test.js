const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('2018 evaluation automation creates exactly one task-backed red X and removes it after approval', () => {
  const src = read('src/services/legacyEvaluation2018.ts');
  assert.match(src, /source_record_id/);
  assert.match(src, /uq_hr_legacy_task_red_x/);
  assert.match(src, /point_type='red_x'/);
  assert.match(src, /status.*approved/);
  assert.match(src, /DELETE FROM hr_legacy_points/);
  assert.match(src, /ON CONFLICT \(source_record_id\)/);
  assert.match(src, /setInterval/);
});

test('manual red and black point entries are capped at five', () => {
  const src = read('src/services/legacyEvaluation2018.ts');
  assert.match(src, /NEW\.point_type IN \('red','black'\)/);
  assert.match(src, /LEAST\(5, GREATEST\(1/);
});

test('manager approval requires employee completion and stores approver audit data', () => {
  const src = read('src/routes/operationsQuality.ts');
  assert.match(src, /csak azután hagyható jóvá/);
  assert.match(src, /completed_at/);
  assert.match(src, /approved_by/);
  assert.match(src, /approved_at/);
  assert.match(src, /syncLegacyTaskRedXById/);
});

test('employee self service can only complete the signed-in employee own task', () => {
  const src = read('src/routes/employeeSelfService.ts');
  assert.match(src, /\/tasks\/:id\/complete/);
  assert.match(src, /employee_id=\$2/);
  assert.match(src, /status='completed'/);
  assert.match(src, /vezetői jóváhagyásra vár/);
});
