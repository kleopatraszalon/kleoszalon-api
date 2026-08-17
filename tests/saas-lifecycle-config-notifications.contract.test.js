const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const route=fs.readFileSync(path.join(__dirname,'..','src','routes','saasLifecyclePolicy.ts'),'utf8');
const migration=fs.readFileSync(path.join(__dirname,'..','src','sql','20260817_SAAS_LIFECYCLE_POLICY_V9.sql'),'utf8');
const bootstrap=fs.readFileSync(path.join(__dirname,'..','src','finance','ensureFinanceNav.ts'),'utf8');

test('lifecycle policy config is persisted and bounded',()=>{
 assert.match(migration,/saas_lifecycle_policy_config/);
 assert.match(migration,/trial_warning_days BETWEEN 1 AND 30/);
 assert.match(migration,/trial_grace_days BETWEEN 0 AND 30/);
 assert.match(route,/router\.patch\("\/lifecycle-policy\/config"/);
});

test('notification preparation is idempotent via dedupe key',()=>{
 assert.match(migration,/dedupe_key text NOT NULL UNIQUE/);
 assert.match(route,/ON CONFLICT\(dedupe_key\) DO NOTHING/);
 assert.match(route,/prepare-notifications/);
});

test('notification queue remains platform-admin protected and observable',()=>{
 const guard=route.indexOf('router.use(requirePlatformAdmin)');
 const queue=route.indexOf('router.get("/lifecycle-policy/notifications"');
 assert.ok(guard>=0&&queue>guard);
 assert.match(route,/recipient_email/);
 assert.match(route,/status/);
});

test('lifecycle schema is part of deterministic startup bootstrap',()=>{
 assert.match(bootstrap,/20260817_SAAS_LIFECYCLE_POLICY_V9\.sql/);
});
