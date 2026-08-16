'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('KLEO-FUN-BOOK-003-AC-02 public cancellation is idempotent', () => {
  const src = read('src/routes/bookingManage.ts');
  assert.match(src, /currentStatus===\"cancelled\"\|\|currentStatus===\"canceled\"/);
  assert.match(src, /idempotent:true/);
  assert.match(src, /cancelled_at=COALESCE\(cancelled_at,now\(\)\)/);
});

test('KLEO-FUN-AUTH-001-AC-02 login rejects an unauthorized selected location', () => {
  const src = read('src/routes/auth.ts');
  assert.match(src, /requestedLocationId && String\(employee\.location_id\) !== requestedLocationId/);
  assert.match(src, /requestedLocationId && !admin && String\(user\.location_id \?\? \"\"\) !== requestedLocationId/);
  assert.match(src, /res\.status\(403\).*telephelyhez nincs jogosultságod/s);
});

test('server logout invalidates the HttpOnly authentication cookie', () => {
  const src = read('src/routes/auth.ts');
  assert.match(src, /router\.post\(\"\/logout\"/);
  assert.match(src, /clearAuthCookie\(res\)/);
  assert.match(src, /res\.clearCookie\(\"token\", authCookieOptions\(\)\)/);
  assert.match(src, /Cache-Control\", \"no-store/);
});
