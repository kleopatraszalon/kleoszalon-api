const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const route=fs.readFileSync(path.join(__dirname,'..','src','routes','saasLifecyclePolicy.ts'),'utf8');
const service=fs.readFileSync(path.join(__dirname,'..','src','services','saasLifecycleOpsAlerts.ts'),'utf8');
const bootstrap=fs.readFileSync(path.join(__dirname,'..','src','finance','ensureFinanceNav.ts'),'utf8');

test('ops alerts V11 migration is bootstrapped',()=>{assert.match(bootstrap,/20260817_SAAS_LIFECYCLE_OPS_ALERTS_V11\.sql/)});
test('watchdog is singleton and independently scheduled after lifecycle cycle',()=>{assert.match(service,/12 \* \* \* \*/);assert.match(service,/pg_try_advisory_lock/);assert.match(service,/WATCHDOG_LOCK/)});
test('critical alerts can escalate to configured platform recipients with cooldown',()=>{assert.match(service,/SAAS_LIFECYCLE_OPS_ALERT_EMAILS/);assert.match(service,/12\*60\*60\*1000/);assert.match(service,/\[KleoSaaS CRITICAL\]/)});
test('watchdog detects scheduler failure stale run failed queue and backlog',()=>{for(const key of ['scheduler:last-run-failed','scheduler:stale','queue:failed','queue:backlog'])assert.match(service,new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))});
test('platform endpoints support alert list acknowledgement resolution and reconcile',()=>{assert.match(route,/\/lifecycle-policy\/alerts/);assert.match(route,/\/acknowledge/);assert.match(route,/\/resolve/);assert.match(route,/alerts\/reconcile/);assert.match(route,/runLifecycleOpsWatchdog/)});
