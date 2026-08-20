const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'vir.ts'), 'utf8');

test('VIR reports use the canonical scoped router', () => {
  assert.match(source, /router\.use\(requireAuth\)/);
  assert.match(source, /function getScopedLocationId\(req: AuthRequest, res: Response\)/);
  assert.match(source, /if \(roles\.includes\("admin"\)\) return requestedLocationId \|\| null/);
  assert.match(source, /if \(!userLocationId\)[\s\S]*res\.status\(403\)/);
});

test('ranked VIR reads are bounded in SQL', () => {
  assert.match(source, /function parseLimit\(value: string \| undefined, fallback = 10, max = 100\)/);
  assert.match(source, /parseLimit\(query\.limit, 10, 50\)/);
  assert.equal((source.match(/LIMIT \$2::integer/g) || []).length >= 2, true);
});

test('heavy VIR report endpoints apply server-side location scope', () => {
  for (const route of ['dashboard','revenue-series','top-services','top-staff','source-performance','cancellation-stats','kiosk-conversion','signage-impact']) {
    assert.match(source, new RegExp(`router\\.get\\(\\"/${route}\\"`));
  }
  assert.equal((source.match(/getScopedLocationId\(req, res\)/g) || []).length >= 8, true);
  assert.match(source, /WHERE \(\$1::uuid IS NULL OR a\.location_id=\$1::uuid\)/);
  assert.match(source, /AND \(\$3::uuid IS NULL OR location_id = \$3::uuid\)/);
});
