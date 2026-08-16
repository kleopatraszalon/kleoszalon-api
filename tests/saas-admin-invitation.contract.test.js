const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const service=read('src/services/tenantAdminInvitations.ts');
const platform=read('src/routes/saasPlatform.ts');
const pub=read('src/routes/tenantAdminInvitationsPublic.ts');
const saas=read('src/routes/saas.ts');
const bootstrap=read('src/finance/ensureFinanceNav.ts');
const migration=read('src/sql/20260816_SAAS_ADMIN_INVITATIONS_V8.sql');

test('admin invitation token is cryptographically random, hash-only and expiring',()=>{
  assert.match(service,/crypto\.randomBytes\(32\)/);
  assert.match(service,/createHash\("sha256"\)/);
  assert.match(service,/token_hash/);
  assert.doesNotMatch(migration,/raw_token|token_plain|activation_token text/i);
  assert.match(service,/INVITE_TTL_HOURS/);
  assert.match(service,/expires_at/);
});

test('platform admin can issue and inspect invitation without exposing raw token',()=>{
  assert.match(platform,/\/tenants\/:tenantId\/admin-invitation/);
  assert.match(platform,/issueTenantAdminInvitation/);
  assert.match(platform,/latestTenantAdminInvitation/);
  assert.doesNotMatch(platform,/rawToken/);
});

test('public activation is mounted before SaaS authentication guard',()=>{
  const publicMount=saas.indexOf('router.use("/admin-invitations",tenantAdminInvitationsPublic)');
  const authMount=saas.indexOf('router.use(requireAuth, requireTenantContext)');
  assert.ok(publicMount>=0&&authMount>=0&&publicMount<authMount);
  assert.match(pub,/router\.get\("\/:token"/);
  assert.match(pub,/router\.post\("\/:token\/accept"/);
  assert.match(pub,/Cache-Control", "no-store/);
});

test('activation is single-use and creates owner membership atomically with bcrypt password',()=>{
  assert.match(service,/bcrypt\.hash\(password, 12\)/);
  assert.match(service,/SELECT i\.\*,t\.name tenant_name[\s\S]*FOR UPDATE/);
  assert.match(service,/invite\.status !== "pending"/);
  assert.match(service,/INSERT INTO tenant_users/);
  assert.match(service,/tenant_role,active\) VALUES\(\$1,\$2,'owner',true\)/);
  assert.match(service,/status='accepted'/);
  assert.match(service,/BEGIN/);
  assert.match(service,/COMMIT/);
  assert.match(service,/ROLLBACK/);
});

test('invitation email uses shared mail transport and startup installs schemas',()=>{
  assert.match(service,/sendEmail/);
  assert.match(service,/tenant-admin-activation\?token=/);
  assert.match(bootstrap,/20260816_SAAS_ONBOARDING_V7\.sql/);
  assert.match(bootstrap,/20260816_SAAS_ADMIN_INVITATIONS_V8\.sql/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS tenant_admin_invitations/);
});
