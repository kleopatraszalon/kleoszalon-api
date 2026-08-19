const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const tenant=fs.readFileSync('src/middleware/tenantContext.ts','utf8');
const auth=fs.readFileSync('src/middleware/auth.ts','utf8');

test('tenant context has no implicit Kleopatra/default fallback',()=>{
  assert.doesNotMatch(tenant,/slug\s*=\s*['"]kleopatra['"]/i);
  assert.doesNotMatch(tenant,/fallback\.rows|if\s*\(!tenant\s*&&\s*userId\)/);
  assert.match(tenant,/FROM tenant_users tu/);
  assert.match(tenant,/tu\.active=true/);
  assert.match(tenant,/JOIN tenants t ON t\.id=tu\.tenant_id/);
  assert.match(tenant,/\(\$2='' OR t\.id::text=\$2\)/);
});

test('staff tenant context requires explicit employee ownership',()=>{
  assert.match(tenant,/employeeId/);
  assert.match(tenant,/FROM employees e/);
  assert.match(tenant,/LEFT JOIN locations l/);
  assert.match(tenant,/COALESCE\(e\.tenant_id,l\.tenant_id\)/);
  assert.match(tenant,/e\.id::text=\$1/);
  assert.match(tenant,/COALESCE\(e\.active,true\)=true/);
});

test('auth middleware preserves employee_id from the verified token',()=>{
  assert.match(auth,/employee_id\?: number \| string \| null/);
  assert.match(auth,/decoded\.employee_id/);
  assert.match(auth,/employee_id: preservedEmployeeId \?\? decoded\.employee_id \?\? null/);
});

test('tenant access fails closed when no explicit ownership is found',()=>{
  assert.match(tenant,/TENANT_ACCESS_DENIED/);
  assert.doesNotMatch(tenant,/LIKE '%admin%'.*owner/s);
});
