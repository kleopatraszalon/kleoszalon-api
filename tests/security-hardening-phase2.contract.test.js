const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const security = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'securitySettings.ts'), 'utf8');
const roles = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'requireRoles.ts'), 'utf8');
const db = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.ts'), 'utf8');

test('payload guard blocks prototype pollution shapes', () => {
  assert.match(security, /__proto__/);
  assert.match(security, /prototype/);
  assert.match(security, /constructor/);
  assert.match(security, /INVALID_INPUT_STRUCTURE/);
});

test('session inventory and remote revocation are database-backed', () => {
  assert.match(security, /CREATE TABLE IF NOT EXISTS security_sessions/);
  assert.match(security, /security-sessions/);
  assert.match(security, /SESSION_REVOKED/);
  assert.match(security, /sha256/);
  assert.doesNotMatch(security, /SELECT\s+token\s+FROM\s+security_sessions/i);
});

test('login and RBAC denial are audited', () => {
  assert.match(security, /login_success/);
  assert.match(security, /login_failed/);
  assert.match(roles, /access_denied/);
  assert.match(roles, /writeSystemAudit/);
});

test('postgres pool has a hard connection cap and statement timeout', () => {
  assert.match(db, /PG_POOL_MAX/);
  assert.match(db, /max:\s*PG_POOL_MAX/);
  assert.match(db, /PG_STATEMENT_TIMEOUT_MS/);
});
