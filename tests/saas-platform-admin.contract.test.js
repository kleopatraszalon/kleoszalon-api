const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const platform=fs.readFileSync(path.join(process.cwd(),'src','routes','saasPlatform.ts'),'utf8');
const saas=fs.readFileSync(path.join(process.cwd(),'src','routes','saas.ts'),'utf8');

test('platform tenant administration is root-tenant and system-admin protected',()=>{
  assert.match(platform,/SYSTEM_ADMIN_ROLES/);
  assert.match(platform,/req\.tenant\?\.slug/);
  assert.match(platform,/===\s*"kleopatra"/);
  assert.match(platform,/PLATFORM_ADMIN_FORBIDDEN/);
  assert.match(saas,/router\.use\("\/platform",saasPlatformRouter\)/);
});

test('platform can list and create tenants with an explicit subscription plan',()=>{
  assert.match(platform,/router\.get\("\/tenants"/);
  assert.match(platform,/subscription_plans/);
  assert.match(platform,/location_count/);
  assert.match(platform,/user_count/);
  assert.match(platform,/franchise_location_count/);
  assert.match(platform,/router\.post\("\/tenants"/);
  assert.match(platform,/INSERT INTO tenants/);
  assert.match(platform,/INSERT INTO subscriptions/);
  assert.match(platform,/tenant_created/);
});

test('root tenant cannot be suspended or cancelled from platform UI contract',()=>{
  assert.match(platform,/ROOT_TENANT_PROTECTED/);
  assert.match(platform,/current\.rows\[0\]\.slug===\"kleopatra\"/);
  assert.match(platform,/status!==\"active\"/);
});

test('platform user assignment is tenant-scoped and role allowlisted',()=>{
  assert.match(platform,/router\.post\("\/tenants\/:tenantId\/users"/);
  assert.match(platform,/\["owner","admin","manager","member"\]/);
  assert.match(platform,/ON CONFLICT\(tenant_id,user_id\)/);
});
