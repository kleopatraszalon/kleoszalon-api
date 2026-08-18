'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('executive AI uses deterministic VIR signals for every requested management question',()=>{
 const src=read('src/services/executiveAiAssistant.ts');
 for(const key of ['revenue.change','staff.low_capacity','appointments.no_show','stock.risk','locations.outlier','marketing.action','staff.shortage_forecast','complaints.urgent'])assert.match(src,new RegExp(key.replace(/[.]/g,'\\.')));
 for(const table of ['financial_movements','appointments','employees','inventory_warehouse_balances','inventory_movements','operations_quality_records'])assert.match(src,new RegExp(table));
 assert.match(src,/Kizárólag a kapott, determinisztikusan kiszámított üzleti adatokból dolgozz/);
 assert.match(src,/nem autonóm döntéshozó/i);
});

test('executive AI automation is scheduled and critical alerts are audited',()=>{
 const src=read('src/services/executiveAiAssistant.ts');
 for(const cron of ['10 8 * * *','10 13 * * *','10 20 * * *'])assert.ok(src.includes(cron));
 assert.match(src,/Europe\/Budapest/);
 assert.match(src,/executive_ai_alert_events/);
 assert.match(src,/executive_ai_alert_deliveries/);
 assert.match(src,/getApmAdminRecipients/);
 assert.match(src,/sendEmail/);
 assert.match(src,/EXECUTIVE_AI_ALERT_COOLDOWN_MINUTES/);
 assert.match(src,/EXECUTIVE_AI_MONTHLY_BUDGET_USD/);
});

test('executive AI is mounted below AI Support and exposes brief ask history and automation APIs',()=>{
 const support=read('src/routes/aiSupport.ts');
 const route=read('src/routes/executiveAi.ts');
 assert.match(support,/router\.use\("\/executive", requireAuth, requireManagement, executiveAiRouter\)/);
 for(const endpoint of ['/brief','/run','/ask','/history','/automation'])assert.ok(route.includes(`"${endpoint}"`));
 assert.match(route,/startExecutiveAiScheduler\(\)/);
 assert.match(route,/ensureExecutiveAiMenu/);
});

test('AI executive assistant is registered in Analytics VIR menu for management only',()=>{
 const menu=read('src/services/executiveAiMenu.ts');
 assert.match(menu,/analytics\.executive_ai/);
 assert.match(menu,/AI vezetői asszisztens/);
 assert.match(menu,/\/finance\/executive-ai/);
 assert.match(menu,/VALUES\('admin'\),\('manager'\)/);
 assert.match(menu,/NOT IN\('admin','manager'\)/);
});
