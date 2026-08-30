const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'securitySettings.ts'), 'utf8');

test('security hardening installs core response headers', () => {
  for (const header of [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
    'Content-Security-Policy',
    'Strict-Transport-Security',
  ]) {
    assert.match(source, new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('security hardening protects auth and public booking separately', () => {
  assert.match(source, /path === "\/login"/);
  assert.match(source, /path\.startsWith\("\/auth\/"\)/);
  assert.match(source, /path\.startsWith\("\/public\/booking"\)/);
  assert.match(source, /login: \{ enabled: true, max: 10/);
  assert.match(source, /booking: \{ enabled: true, max: 120/);
});

test('security hardening includes progressive brute-force blocking', () => {
  assert.match(source, /BRUTE_THRESHOLD = 5/);
  assert.match(source, /BRUTE_BLOCK_STEPS_MS/);
  assert.match(source, /AUTH_TEMPORARILY_BLOCKED/);
  assert.match(source, /res\.statusCode !== 401 && res\.statusCode !== 403/);
});

test('cloudflare token remains status-only', () => {
  assert.match(source, /api_token_configured: Boolean\(process\.env\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(source, /api_token:\s*process\.env\.CLOUDFLARE_API_TOKEN/);
});
