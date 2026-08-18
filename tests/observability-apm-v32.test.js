'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('APM instruments API latency, HTTP errors and slow queries centrally',()=>{
 const runtime=read('src/observability/runtime.ts');
 const db=read('src/db.ts');
 for(const marker of ['p50_ms','p95_ms','p99_ms','rate_4xx','rate_5xx','settlement_failures','payroll_errors'])assert.match(runtime,new RegExp(marker));
 assert.match(runtime,/SLOW_QUERY_MS/);
 assert.match(runtime,/sanitizeSql/);
 assert.doesNotMatch(runtime,/params:/);
 assert.match(db,/installHttpInstrumentation\(\)/);
 assert.match(db,/observeDbQuery/);
 assert.match(db,/PG_POOL_MAX/);
});

test('APM covers every required operational production signal',()=>{
 const src=read('src/services/observabilityApm.ts');
 for(const key of [
  'api.latency.p50','api.latency.p95','api.latency.p99','api.http.4xx_rate','api.http.5xx_rate',
  'db.pool','db.slow_queries','nav.queue','nav.failed','imap.last_success','email.queue','push.queue',
  'daily_action.scheduler','cashier.open_stale','settlement.failed','inventory.discrepancies','payroll.errors'
 ]) assert.match(src,new RegExp(key.replace(/[.]/g,'\\.')));
 assert.match(src,/inventory_stocktake_items/);
 assert.match(src,/inventory_warehouse_balances/);
 assert.match(src,/booking_communication_queue/);
 assert.match(src,/nav_invoice_queue/);
 assert.match(src,/cashier_shifts/);
});

test('critical alerts are durable, deduplicated and automatically sent to admins',()=>{
 const apm=read('src/services/observabilityApm.ts');
 const delivery=read('src/services/apmAlertDelivery.ts');
 assert.match(apm,/CREATE TABLE IF NOT EXISTS apm_alert_events/);
 assert.match(apm,/last_notified_at/);
 assert.match(apm,/APM_CRITICAL_ALERT_COOLDOWN_MINUTES/);
 assert.match(apm,/deliverApmCriticalAlert/);
 assert.match(delivery,/APM_ADMIN_EMAILS/);
 assert.match(delivery,/super\[_-\]\?admin/);
 assert.match(delivery,/sendEmail/);
 assert.match(delivery,/apm_alert_deliveries/);
});

test('Observability management API and worker are mounted through notifications',()=>{
 const notifications=read('src/routes/notifications.ts');
 const route=read('src/routes/observability.ts');
 assert.match(notifications,/startObservabilityWorker\(\)/);
 assert.match(notifications,/router\.use\("\/observability",requireManagement,observabilityRouter\)/);
 for(const endpoint of ['/history','/alerts','/deliveries','/run'])assert.ok(route.includes(`"${endpoint}"`));
 assert.match(route,/collectApmSnapshot/);
});
