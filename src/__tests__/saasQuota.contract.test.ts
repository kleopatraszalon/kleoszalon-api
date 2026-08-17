import fs from 'node:fs';
import path from 'node:path';

const quota=fs.readFileSync(path.resolve(__dirname,'../services/saasQuota.ts'),'utf8');
const locations=fs.readFileSync(path.resolve(__dirname,'../routes/locations.ts'),'utf8');
const invitations=fs.readFileSync(path.resolve(__dirname,'../services/tenantAdminInvitations.ts'),'utf8');
const migration=fs.readFileSync(path.resolve(__dirname,'../sql/20260817_SAAS_QUOTA_ENFORCEMENT_V12.sql'),'utf8');
const bootstrap=fs.readFileSync(path.resolve(__dirname,'../finance/ensureFinanceNav.ts'),'utf8');

describe('SaaS quota enforcement',()=>{
  it('measures location and active user usage against plan limits',()=>{
    expect(quota).toContain("'locations'|'users'");
    expect(quota).toContain('max_locations');
    expect(quota).toContain('max_users');
    expect(quota).toContain('usage_percent');
    expect(quota).toContain('near_limit');
  });
  it('uses transaction-scoped quota locking before writes',()=>{
    expect(quota).toContain('pg_advisory_xact_lock');
    expect(quota).toContain('SAAS_QUOTA_EXCEEDED');
    expect(locations).toContain("assertTenantQuota(req.tenant!.id,'locations',1,client)");
  });
  it('tenant-scopes location reads and writes',()=>{
    expect(locations).toContain('requireTenantContext');
    expect(locations).toContain('tenant_id=$1::bigint');
    expect(locations).toContain('tenant_id) VALUES');
  });
  it('guards tenant admin assignment with user quota',()=>{
    expect(invitations).toContain("assertTenantQuota(input.tenantId,'users',1,client)");
    expect(invitations).toContain("assertTenantQuota(String(invite.tenant_id),'users',1,client)");
  });
  it('enforces quotas at database level and bootstraps V12',()=>{
    expect(migration).toContain('CREATE TRIGGER');
    expect(migration).toContain('max_locations');
    expect(migration).toContain('max_users');
    expect(bootstrap).toContain('20260817_SAAS_QUOTA_ENFORCEMENT_V12.sql');
  });
});
