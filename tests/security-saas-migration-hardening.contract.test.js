const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const read=(p)=>fs.readFileSync(p,'utf8');

test('tenant context has no implicit Kleopatra runtime fallback',()=>{
  const src=read('src/middleware/tenantContext.ts');
  assert.doesNotMatch(src,/slug\s*=\s*['"]kleopatra['"]/i);
  assert.match(src,/tenant_users/);
  assert.match(src,/JOIN locations/);
  assert.match(src,/TENANT_ACCESS_DENIED/);
});

test('standard browser login uses HttpOnly cookie and does not serialize bearer JWT',()=>{
  const src=read('src/routes/auth.ts');
  assert.match(src,/httpOnly:\s*true/);
  assert.match(src,/auth_transport:\s*["']http_only_cookie["']/);
  assert.match(src,/sameSite:\s*\(production \? ["']none["'] : ["']lax["']\)/);

  const employeeResponse=src.slice(src.indexOf('async function respondAsEmployee'),src.indexOf('async function verifyGitHubUatToken'));
  assert.doesNotMatch(employeeResponse,/\n\s*token,\s*\n/,'employee browser response must not return JWT');

  const loginRoute=src.slice(src.indexOf('router.post("/login"'),src.indexOf('router.post("/employee-login"'));
  assert.doesNotMatch(loginRoute,/\n\s*token,\s*\n/,'browser login response must not return JWT');
  assert.match(loginRoute,/tenant_id:\s*tenantId/);
});

test('cookie authentication rejects cross-site unsafe requests while bearer UAT remains supported',()=>{
  const src=read('src/middleware/auth.ts');
  assert.match(src,/CredentialSource = ["']bearer["'] \| ["']cookie["']/);
  assert.match(src,/sec-fetch-site/);
  assert.match(src,/cross-site/);
  assert.match(src,/CSRF_ORIGIN_REJECTED/);
  assert.match(src,/credential\.source === ["']cookie["']/);
});

test('database schema is versioned and migrations run before API startup',()=>{
  const pkg=JSON.parse(read('package.json'));
  const runner=read('src/dbMigrations.ts');
  const migration=read('src/migrations/20260818_001_saas_tenant_baseline.sql');
  assert.equal(pkg.scripts.migrate,'node dist/dbMigrations.js');
  assert.match(pkg.scripts.start,/npm run migrate/);
  assert.match(runner,/schema_migrations/);
  assert.match(runner,/checksum_sha256/);
  assert.match(runner,/pg_advisory_lock/);
  assert.match(runner,/Migration checksum mismatch/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS tenants/);
  assert.match(migration,/INSERT INTO tenant_users/);
});
