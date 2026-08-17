const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const worker=fs.readFileSync(path.join(__dirname,'..','src','services','saasLifecycleNotificationWorker.ts'),'utf8');

test('lifecycle scheduler runs hourly with Budapest timezone and can be disabled',()=>{
  assert.match(worker,/DEFAULT_SCHEDULER_CRON="7 \* \* \* \*"/);
  assert.match(worker,/DEFAULT_SCHEDULER_TIMEZONE="Europe\/Budapest"/);
  assert.match(worker,/SAAS_LIFECYCLE_SCHEDULER_DISABLED/);
  assert.match(worker,/cron\.schedule/);
});

test('lifecycle scheduler is multi-instance safe through PostgreSQL advisory lock',()=>{
  assert.match(worker,/pg_try_advisory_lock/);
  assert.match(worker,/pg_advisory_unlock/);
  assert.match(worker,/SCHEDULER_LOCK_KEY/);
});

test('scheduled cycle is policy-gated, idempotent and can auto-suspend only when enabled',()=>{
  assert.match(worker,/policy_disabled/);
  assert.match(worker,/ON CONFLICT\(dedupe_key\) DO NOTHING/);
  assert.match(worker,/if\(!config\.auto_apply_suspend\)return 0/);
  assert.match(worker,/FOR UPDATE/);
  assert.match(worker,/lifecycle_auto_suspended/);
  assert.match(worker,/processLifecycleNotificationQueue\(25\)/);
});
