const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('browser login sets a production-compatible HttpOnly partitioned cookie', () => {
  const source = read('src/routes/auth.ts');
  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /sameSite:\s*\(production\s*\?\s*"none"\s*:\s*"lax"\)/);
  assert.match(source, /secure:\s*production/);
  assert.match(source, /partitioned:\s*production/);
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

test('cookie-authenticated mutations trust only allowlisted explicit origins and otherwise fail closed', () => {
  const source = read('src/middleware/auth.ts');
  assert.match(source, /browserCookieMutationAllowed/);
  assert.match(source, /CSRF_ORIGIN_REJECTED/);
  assert.match(source, /fetchSite === "cross-site"/);
  assert.match(source, /https:\/\/kleoszalon-frontend\.onrender\.com/);
  assert.match(source, /trustedBrowserOrigins\(\)\.has\(origin\)/);
  assert.match(source, /if \(bearerHeader\(req\)\) return true/);
  assert.match(source, /return fetchSite === "same-origin"/);

  const originCheck = source.indexOf('if (origin) return trustedBrowserOrigins().has(origin)');
  const crossSiteFallback = source.indexOf('if (fetchSite === "cross-site") return false');
  assert.ok(originCheck >= 0, 'trusted Origin check must exist');
  assert.ok(crossSiteFallback > originCheck, 'allowlisted explicit Origin must be checked before generic cross-site rejection');
});

test('invalid and expired browser JWTs clear the auth cookie with matching production attributes', () => {
  const source = read('src/middleware/auth.ts');
  assert.match(source, /function clearBrowserAuthCookie/);
  assert.match(source, /partitioned:\s*production/);
  assert.match(source, /sameSite:\s*production\s*\?\s*"none"\s*:\s*"lax"/);

  const expiredStart = source.indexOf('if (err.name === "TokenExpiredError")');
  const invalidStart = source.indexOf('if (["JsonWebTokenError", "NotBeforeError"]');
  assert.ok(expiredStart >= 0 && invalidStart > expiredStart);
  assert.match(source.slice(expiredStart, invalidStart), /clearBrowserAuthCookie\(res\)/);
  assert.match(source.slice(invalidStart), /clearBrowserAuthCookie\(res\)/);
});

test('server CORS remains credentialed and allowlist based', () => {
  const source = read('src/server.ts');
  assert.match(source, /credentials:true/);
  assert.match(source, /originAllowed\(origin\)/);
  assert.match(source, /https:\/\/kleoszalon-frontend\.onrender\.com/);
  assert.doesNotMatch(source, /Cors origin allowed without allowlist match/i);
});
