const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('employee HR/payroll writes are fail-closed for non-management roles', () => {
  const src = read('src/middleware/locationManagerScope.ts');
  assert.match(src, /canManageEmployees/);
  assert.match(src, /isWrite\|\|sensitiveRead/);
  assert.match(src, /Dolgozói, bér- és HR-adatok módosítása csak vezetői jogosultsággal/);
  assert.match(src, /safeEmployeeRow/);
  assert.match(src, /safePositionRow/);
});

test('location managers remain strictly scoped to their own employee records', () => {
  const src = read('src/middleware/locationManagerScope.ts');
  assert.match(src, /entityInLocation\("employees",id,locationId\)/);
  assert.match(src, /sanitizeCreatedEmployee\(req,locationId\)/);
  assert.match(src, /req\.body\.records=req\.body\.records\.map/);
});

test('workorder editor cache is authorization-scope aware and keeps the optimized bounded TTL', () => {
  const src = read('src/routes/workOrderEditorFast.ts');
  assert.match(src, /admin\?'admin':'scoped'/);
  assert.doesNotMatch(src, /const key=`\$\{locationId\}:\$\{requestedEmployee/);
  assert.match(src, /Promise\.all/);
  assert.match(src, /const TTL_MS=5\*60\*1000/);
  assert.match(src, /const LOCATION_TTL_MS=5\*60\*1000/);
  assert.match(src, /cache\.set\(key,\{expires:Date\.now\(\)\+TTL_MS,value\}\)/);
});

test('critical transaction routes remain authenticated and management actions stay protected', () => {
  const src = read('src/routes/transactions.ts');
  assert.match(src, /router\.use\(requireAuth\)/);
  assert.match(src, /daily-actions\/auto-selector",requireManagement/);
  assert.match(src, /daily-actions",requireManagement/);
  assert.match(src, /newsletters",requireManagement/);
});

test('release candidate keeps health and readiness probes', () => {
  const src = read('src/server.ts');
  assert.match(src, /\/api\/health/);
  assert.match(src, /\/api\/health\/ready/);
  assert.match(src, /db_unreachable/);
});
