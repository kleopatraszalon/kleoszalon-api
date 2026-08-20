const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('browser login sets a production-compatible HttpOnly cookie', () => {
  const source = read('src/routes/auth.ts');
  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /sameSite:\s*\(production\s*\?\s*"none"\s*:\s*"lax"\)/);
  assert.match(source, /secure:\s*production/);
  assert.match(source, /Cache-Control/);

  const employeeStart = source.indexOf('async function respondAsEmployee');
  const employeeEnd = source.indexOf('async function verifyGitHubUatToken');
  const employeeFlow = source.slice(employeeStart, employeeEnd);
  assert.match(employeeFlow, /setAuthCookie\(res, token\)/);

  const loginStart = source.indexOf('router.post("/login"');
  const loginEnd = source.indexOf('router.post("/employee-login"');
  const loginFlow = source.slice(loginStart, loginEnd);
  assert.match(loginFlow, /setAuthCookie\(res, token\)/);
});

test('migration phase deliberately preserves old login JSON clients until frontend cutover', () => {
  const source = read('src/routes/auth.ts');
  assert.match(source, /Transitional compatibility only/);

  const employeeStart = source.indexOf('async function respondAsEmployee');
  const employeeEnd = source.indexOf('async function verifyGitHubUatToken');
  assert.match(source.slice(employeeStart, employeeEnd), /\btoken,/);

  const loginStart = source.indexOf('router.post("/login"');
  const loginEnd = source.indexOf('router.post("/employee-login"');
  assert.match(source.slice(loginStart, loginEnd), /\btoken,/);
});

test('GitHub UAT bearer bootstrap remains explicit and isolated', () => {
  const source = read('src/routes/auth.ts');
  assert.match(source, /router\.post\("\/uat\/accounting-token"/);
  assert.match(source, /router\.post\("\/uat\/nav-test-token"/);
  assert.match(source, /return res\.json\(\{success:true,token,expires_in_seconds:600/);
});

test('cookie-authenticated mutations fail closed on untrusted browser origins', () => {
  const source = read('src/middleware/auth.ts');
  assert.match(source, /browserCookieMutationAllowed/);
  assert.match(source, /CSRF_ORIGIN_REJECTED/);
  assert.match(source, /fetchSite === "cross-site"/);
  assert.match(source, /https:\/\/kleoszalon-frontend\.onrender\.com/);
  assert.match(source, /trustedBrowserOrigins\(\)\.has\(origin\)/);
  assert.match(source, /if \(bearerHeader\(req\)\) return true/);
  assert.match(source, /return fetchSite === "same-origin"/);
});

test('server CORS remains credentialed and allowlist based', () => {
  const source = read('src/server.ts');
  assert.match(source, /credentials:true/);
  assert.match(source, /originAllowed\(origin\)/);
  assert.match(source, /https:\/\/kleoszalon-frontend\.onrender\.com/);
  assert.doesNotMatch(source, /Cors origin allowed without allowlist match/i);
});
