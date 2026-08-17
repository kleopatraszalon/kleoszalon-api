const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const route=fs.readFileSync(path.join(__dirname,'..','src','routes','saasLifecyclePolicy.ts'),'utf8');
const worker=fs.readFileSync(path.join(__dirname,'..','src','services','saasLifecycleNotificationWorker.ts'),'utf8');
const bootstrap=fs.readFileSync(path.join(__dirname,'..','src','finance','ensureFinanceNav.ts'),'utf8');

test('lifecycle observability migration is in bootstrap',()=>{assert.match(bootstrap,/20260817_SAAS_LIFECYCLE_OBSERVABILITY_V10\.sql/)});
test('scheduler writes durable run history',()=>{assert.match(worker,/saas_lifecycle_scheduler_runs/);assert.match(worker,/triggerSource:'scheduled'\|'manual'/);assert.match(worker,/finishRun\(runId,'failed'/)});
test('platform exposes health and manual run endpoints',()=>{assert.match(route,/\/lifecycle-policy\/health/);assert.match(route,/\/lifecycle-policy\/run-now/);assert.match(route,/runSaasLifecycleSchedulerCycle\('manual'\)/)});
test('dead-letter queue supports failed-only retry reset',()=>{assert.match(route,/\/notifications\/:id\/retry/);assert.match(route,/status='failed'/);assert.match(route,/attempts=0/);assert.match(route,/last_error=NULL/)});
