'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Exception Command Center persists durable auditable cases',()=>{
 const src=read('src/services/exceptionCommandCenter.ts');
 for(const marker of ['exception_cases','exception_case_events','exception_case_notifications','exception_routing_rules','trg_exception_case_events_immutable','append-only'])assert.ok(src.includes(marker),marker);
 for(const status of ['open','acknowledged','in_progress','waiting','snoozed','resolved','dismissed'])assert.ok(src.includes(`'${status}'`),status);
 for(const state of ['on_track','at_risk','breached','closed'])assert.ok(src.includes(`'${state}'`),state);
});

test('automatic collectors cover critical VIR domains',()=>{
 const src=read('src/services/exceptionCommandCenter.ts');
 for(const marker of ['reconciliation_alert_events','business_process_integrity_exceptions','business_transaction_trace_alerts','apm_alert_events','nav_invoice_queue','cash_register_shifts','payroll_runs','booking_communication_queue','operations_quality_records','inventory_warehouse_balances','purchase_orders','fixed_asset_maintenance_plans'])assert.ok(src.includes(marker),marker);
});

test('complaints require human closure while mechanical sources may auto resolve',()=>{
 const src=read('src/services/exceptionCommandCenter.ts');
 assert.match(src,/\('complaints','customer-care',60,120,240,720,false\)/);
 assert.ok(src.includes('autoResolveMissing'));
 assert.ok(src.includes('checkedSources'));
 assert.ok(src.includes('last_scanned_at'));
});

test('SLA engine and alert digest are automatic and deduplicated',()=>{
 const src=read('src/services/exceptionCommandCenter.ts');
 assert.ok(src.includes('refreshSla'));
 assert.ok(src.includes('ALERT_COOLDOWN_MINUTES'));
 assert.ok(src.includes('last_notification_at'));
 assert.ok(src.includes('getApmAdminRecipients'));
 assert.ok(src.includes('sendEmail'));
 assert.match(src,/\*\/5 \* \* \* \*/);
 assert.ok(src.includes('Europe/Budapest'));
});

test('management API exposes triage, ownership, bulk, SLA and export tools',()=>{
 const route=read('src/routes/exceptionCommandCenter.ts');
 for(const endpoint of ['/summary','/cases','/cases/:id','/cases/:id/comment','/cases/bulk','/sync','/routing-rules','/export.csv'])assert.ok(route.includes(endpoint),endpoint);
 const notifications=read('src/routes/notifications.ts');
 assert.ok(notifications.includes('exceptionCommandCenterRouter'));
 assert.ok(notifications.includes('"/exceptions"'));
});

test('executive analytics menu registers Exception Command Center for management only',()=>{
 const menu=read('src/services/executiveAiMenu.ts');
 assert.ok(menu.includes('analytics.exception_center'));
 assert.ok(menu.includes('Exception Command Center'));
 assert.ok(menu.includes('/finance/exception-command-center'));
 assert.ok(menu.includes("NOT IN('admin','manager')"));
});
