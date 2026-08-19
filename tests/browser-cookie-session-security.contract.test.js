const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('browser login keeps JWT exclusively in an HttpOnly cookie', () => {
  const source = read('src/routes/auth.ts');
  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /sameSite:\s*\(production\s*\?\s*"none"\s*:\s*"lax"\)/);
  assert.match(source, /secure:\s*production/);

  const employeeStart = source.indexOf('async function respondAsEmployee');
  const employeeEnd = source.indexOf('async function verifyGitHubUatToken');
  const employeeFlow = source.slice(employeeStart, employeeEnd);
  assert.match(employeeFlow, /setAuthCookie\(res, token\)/);
  const employeeJson = employeeFlow.slice(employeeFlow.indexOf('return res.json'));
  assert.doesNotMatch(employeeJson, /\btoken\s*[,}]/, 'employee login must not serialize the JWT');

  const loginStart = source.indexOf('router.post("/login"');
  const loginEnd = source.indexOf('router.post("/employee-login"');
  const loginFlow = source.slice(loginStart, loginEnd);
  assert.match(loginFlow, /setAuthCookie\(res, token\)/);
  const loginJson = loginFlow.slice(loginFlow.lastIndexOf('return res.json'));
  assert.doesNotMatch(loginJson, /\btoken\s*[,}]/, 'browser login must not serialize the JWT');
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
