const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const src=fs.readFileSync(path.join(process.cwd(),'src/routes/transactions.ts'),'utf8');

test('all internal transaction routes require authentication by default',()=>{
  assert.match(src,/import \{ requireAuth \} from ["']\.\.\/middleware\/auth["']/);
  const authIndex=src.indexOf('router.use(requireAuth)');
  const firstRouteIndex=src.indexOf('router.get("/"');
  assert.ok(authIndex>=0,'transactions router must install requireAuth');
  assert.ok(firstRouteIndex>authIndex,'requireAuth must be registered before transaction routes');
});

test('system health and UAT endpoints are management-only on the backend',()=>{
  assert.match(src,/router\.use\("\/system-health",requireManagement,/);
  assert.match(src,/router\.use\("\/uat",requireManagement,/);
  assert.match(src,/router\.use\("\/uat-issues",requireManagement,/);
});
