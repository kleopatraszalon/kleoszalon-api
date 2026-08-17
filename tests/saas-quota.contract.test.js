const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(rel)=>fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
const quota=read('src/services/saasQuota.ts');
const locations=read('src/routes/locations.ts');
const invitations=read('src/services/tenantAdminInvitations.ts');
const migration=read('src/sql/20260817_SAAS_QUOTA_ENFORCEMENT_V12.sql');
const bootstrap=read('src/finance/ensureFinanceNav.ts');

test('SaaS quota measures active location and user usage against plan limits',()=>{
  assert.match(quota,/'locations'\|'users'/);
  assert.match(quota,/max_locations/);
  assert.match(quota,/max_users/);
  assert.match(quota,/usage_percent/);
  assert.match(quota,/near_limit/);
});

test('SaaS quota uses transaction scoped locking and rejects over-limit writes',()=>{
  assert.match(quota,/pg_advisory_xact_lock/);
  assert.match(quota,/SAAS_QUOTA_EXCEEDED/);
  assert.match(locations,/assertTenantQuota\(req\.tenant!\.id,'locations',1,client\)/);
});

test('locations API is tenant scoped',()=>{
  assert.match(locations,/requireTenantContext/);
  assert.match(locations,/tenant_id=\$1::bigint/);
  assert.match(locations,/tenant_id\) VALUES/);
});

test('tenant admin assignment and activation consume user quota',()=>{
  assert.match(invitations,/assertTenantQuota\(input\.tenantId,'users',1,client\)/);
  assert.match(invitations,/assertTenantQuota\(String\(invite\.tenant_id\),'users',1,client\)/);
});

test('V12 enforces quota at database level and is part of startup bootstrap',()=>{
  assert.match(migration,/CREATE TRIGGER/);
  assert.match(migration,/max_locations/);
  assert.match(migration,/max_users/);
  assert.match(bootstrap,/20260817_SAAS_QUOTA_ENFORCEMENT_V12\.sql/);
});
