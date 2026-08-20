const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(rel)=>fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
const route=read('src/routes/saasSelfService.ts');
const service=read('src/services/saasSelfService.ts');
const saas=read('src/routes/saas.ts');
const invite=read('src/routes/tenantAdminInvitationsPublic.ts');

test('self-service endpoints are public but isolated from authenticated SaaS routes',()=>{
 assert.match(saas,/router\.use\("\/self-service",saasSelfServiceRouter\);[\s\S]*router\.use\(requireAuth, requireTenantContext\)/);
 assert.match(route,/router\.get\('\/plans'/);
 assert.match(route,/router\.post\('\/signup'/);
});

test('only START and PRO may start a self-service trial',()=>{
 assert.match(route,/SELF_SERVICE_PLANS=new Set\(\['start','pro'\]\)/);
 assert.match(route,/SELF_SERVICE_PLAN_FORBIDDEN/);
 assert.match(route,/trial_days/);
});

test('signup is idempotent, consent-gated and abuse protected',()=>{
 assert.match(route,/Idempotency-Key/);
 assert.match(route,/IDEMPOTENCY_KEY_REQUIRED/);
 assert.match(route,/LEGAL_CONSENT_REQUIRED/);
 assert.match(route,/SIGNUP_RATE_LIMITED/);
 assert.match(route,/honeypot/);
 assert.match(service,/request_key text NOT NULL UNIQUE/);
 assert.match(service,/terms_version text NOT NULL/);
 assert.match(service,/privacy_version text NOT NULL/);
});

test('tenant provisioning creates company, branding, location, features and onboarding evidence',()=>{
 assert.match(route,/INSERT INTO tenants/);
 assert.match(route,/pending_activation/);
 assert.match(route,/INSERT INTO tenant_branding/);
 assert.match(route,/INSERT INTO locations/);
 assert.match(route,/INSERT INTO tenant_features/);
 assert.match(route,/self_service_provisioned/);
});

test('trial clock starts only after verified admin invitation acceptance',()=>{
 assert.match(route,/trial_ends_at,billing_interval\) VALUES\(\$1::bigint,\$2,'trial',now\(\),NULL,\$3\)/);
 assert.match(invite,/activateSelfServiceTrial/);
 assert.match(service,/trial_ends_at=now\(\)\+\(\$2::text\|\|' days'\)::interval/);
 assert.match(service,/self_service_trial_started/);
});

test('FRANCHISE and ENTERPRISE stay outside self-service flow',()=>{
 assert.doesNotMatch(route,/SELF_SERVICE_PLANS[^\n]*franchise/);
 assert.doesNotMatch(route,/SELF_SERVICE_PLANS[^\n]*enterprise/);
});
