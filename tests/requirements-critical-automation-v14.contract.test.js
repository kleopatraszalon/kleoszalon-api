'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('KLEO-FUN-FIN-002-AC-01: open cashier movement posts a signed ledger effect and deterministic balance', () => {
  const register = read('src/routes/cashierRegister.ts');
  const transactions = read('src/routes/transactions.ts');
  const finance = read('src/routes/financeOperations.ts');
  assert.match(transactions, /guardOpenCashierShift/);
  assert.match(transactions, /cash_register_shifts[\s\S]*status='open'/);
  assert.match(register, /direction === \"in\" \? \"income\" : \"expense\"/);
  assert.match(register, /INSERT INTO financial_movements/);
  assert.match(register, /INSERT INTO cash_register_movements/);
  assert.match(finance, /opening_balance \+ COALESCE\(SUM\(CASE WHEN m\.direction='income' THEN m\.amount ELSE -m\.amount END\),0\) AS current_balance/);
});

test('KLEO-FUN-FIN-002-AC-02: a closed register rejects movements before financial side effects', () => {
  const register = read('src/routes/cashierRegister.ts');
  assert.match(register, /SELECT id FROM cash_register_closings[\s\S]*business_date=\$2::date/);
  assert.match(register, /if \(closed\.rows\[0\]\)[\s\S]*res\.status\(409\)/);
  const guardPos = register.indexOf('if (closed.rows[0])');
  const ledgerPos = register.indexOf('INSERT INTO financial_movements');
  const cashPos = register.indexOf('INSERT INTO cash_register_movements');
  assert.ok(guardPos >= 0 && guardPos < ledgerPos && guardPos < cashPos, 'closed-day guard must precede all writes');
});

test('KLEO-NFR-SEC-002-AC-01: customer password is persisted only as a BCrypt hash', () => {
  const publicMarketing = read('src/routes/publicMarketing.ts');
  assert.match(publicMarketing, /bcrypt\.hash\(password,\s*12\)/);
  assert.match(publicMarketing, /INSERT INTO users\(full_name,email,password_hash,role\)/);
  assert.doesNotMatch(publicMarketing, /INSERT INTO users\([^)]*\bpassword\b[^_]/i);
});

test('KLEO-NFR-SEC-002-AC-02: authentication verifies BCrypt and never serializes the stored hash', () => {
  const auth = read('src/routes/auth.ts');
  assert.match(auth, /bcrypt\.compare\(password,\s*employee\.password_hash\)/);
  assert.match(auth, /bcrypt\.compare\(password,\s*hash\)/);
  assert.match(auth, /return res\.status\(401\)\.json\(\{ error: \"Hibás felhasználó vagy jelszó\.\" \}\)/);
  assert.doesNotMatch(auth, /res\.json\([^)]*password_hash/s);
});

test('KLEO-NFR-SEC-003-AC-01: protected tokens are verified with the server-side signing key before authorization', () => {
  const middleware = read('src/middleware/auth.ts');
  const secret = read('src/security/jwtSecret.ts');
  assert.match(middleware, /jwt\.verify\(token, JWT_SECRET\)/);
  assert.match(middleware, /enforceKnownModuleAccess\(req, res\)/);
  assert.match(secret, /JWT_SECRET is required in production/);
  assert.match(secret, /configuredSecret \|\| \"kleo_local_dev_only_change_me\"/);
});

test('KLEO-NFR-SEC-003-AC-02: expired or modified tokens fail closed with HTTP 401 and no business handler execution', () => {
  const middleware = read('src/middleware/auth.ts');
  assert.match(middleware, /TokenExpiredError/);
  assert.match(middleware, /JsonWebTokenError/);
  assert.match(middleware, /NotBeforeError/);
  assert.match(middleware, /res\.status\(401\)/);
  assert.match(middleware, /res\.clearCookie\(\"token\"/);
  const verifyPos = middleware.indexOf('jwt.verify(token, JWT_SECRET)');
  const nextPos = middleware.indexOf('return next();', verifyPos);
  assert.ok(verifyPos >= 0 && nextPos > verifyPos, 'authorization must happen after successful token verification');
});

test('KLEO-NFR-RES-001-AC-01: retry after a lost cancellation response is idempotent', () => {
  const booking = read('src/routes/bookingManage.ts');
  assert.match(booking, /currentStatus===\"cancelled\"\|\|currentStatus===\"canceled\"/);
  assert.match(booking, /idempotent:true/);
  assert.match(booking, /cancelled_at=COALESCE\(cancelled_at,now\(\)\)/);
  assert.match(booking, /appointment_change_log/);
});

test('KLEO-NFR-QLT-001-AC-02: release-candidate job is fail-closed on automated test failure', () => {
  const workflow = read('.github/workflows/vir-release-candidate.yml');
  assert.match(workflow, /name: Full contract regression suite\s+run: npm test/);
  assert.match(workflow, /name: TypeScript production build\s+run: npm run build/);
  assert.match(workflow, /name: Critical workorder and RBAC regression subset\s+run: npm run test:workorders/);
  assert.doesNotMatch(workflow, /Full contract regression suite[\s\S]{0,160}continue-on-error:\s*true/);
});
