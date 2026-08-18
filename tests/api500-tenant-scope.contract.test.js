const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('dashboard compatibility reads resolve SaaS tenant context before data access',()=>{
  const src=read('src/routes/api500Hotfix.ts');
  assert.match(src,/import\s*\{[^}]*requireTenantContext[^}]*\}\s*from\s*["']\.\.\/middleware\/tenantContext["']/,
    'api500Hotfix must import requireTenantContext');
  assert.match(src,/router\.get\(["']\/employees["'],\s*requireAuth,\s*requireTenantContext,/,
    '/employees hotfix must resolve tenant context');
  assert.match(src,/router\.get\(["']\/timetable["'],\s*requireAuth,\s*requireTenantContext,/,
    '/timetable hotfix must resolve tenant context');
});

test('compatibility layer does not replace the real analytics dashboard with hardcoded zero metrics',()=>{
  const src=read('src/routes/api500Hotfix.ts');
  assert.doesNotMatch(src,/router\.get\(["']\/dashboard["']/,
    'api500Hotfix must not shadow the real /api/dashboard analytics route');
  assert.doesNotMatch(src,/dailyRevenue:0,monthlyRevenue:0,totalRevenue:0/,
    'compatibility layer must not fabricate zero financial analytics');
});

test('authentication request type preserves tenant_id when present in JWT',()=>{
  const src=read('src/middleware/auth.ts');
  assert.match(src,/tenant_id\?:\s*number\s*\|\s*string\s*\|\s*null|tenant_id\?:\s*string\s*\|\s*number\s*\|\s*null/,
    'AuthRequest.user must expose tenant_id');
  assert.match(src,/tenant_id:\s*decoded\.tenant_id\s*\?\?\s*null/,
    'requireAuth must preserve decoded tenant_id');
});
