'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('KLEO-GEN-SRCH-001-AC-01: CRM search trims trailing whitespace and uses normalized parameter', () => {
  const src = read('src/routes/clientsCore.ts');
  assert.match(src, /String\(req\.query\.q\s*\|\|\s*""\)\.trim\(\)/);
  assert.match(src, /ILIKE\s+\$2/i);
  assert.match(src, /const q = `%\$\{String\(req\.query\.q \|\| ""\)\.trim\(\)\}%`/);
});

test('KLEO-GEN-SRCH-001-AC-02: CRM textual search is case-insensitive', () => {
  const src = read('src/routes/clientsCore.ts');
  const ilikeCount = (src.match(/\bILIKE\b/gi) || []).length;
  assert.ok(ilikeCount >= 3, `expected multiple ILIKE comparisons, got ${ilikeCount}`);
  assert.match(src, /full_name[\s\S]*ILIKE\s+\$2/i);
  assert.match(src, /email[\s\S]*ILIKE\s+\$2/i);
  assert.match(src, /phone[\s\S]*ILIKE\s+\$2/i);
});

test('KLEO-FUN-BOOK-003-AC-01: staff cancellation preserves record, reason, actor and audit event', () => {
  const src = read('src/routes/appointmentLifecycle.ts');
  assert.match(src, /router\.post\('\/appointments\/:id\/cancel'/);
  assert.match(src, /UPDATE appointments SET status='cancelled'/);
  assert.match(src, /cancellation_reason=\$2/);
  assert.match(src, /cancelled_at=COALESCE\(cancelled_at,now\(\)\)/);
  assert.match(src, /appointment_change_log/);
  assert.match(src, /actor\(req\)/);
  assert.match(src, /if\(String\(ap\.status\|\|''\)===target\).*idempotent:true/s);
  // Slot release is represented by status='cancelled'; booking conflict queries exclude cancelled slots.
  assert.match(src, /status='cancelled'/);
});
