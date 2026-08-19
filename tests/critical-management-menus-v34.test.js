'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('critical finance and system menus self-heal with parent visibility',()=>{
  const src=read('src/services/businessControlMenu.ts');
  for(const marker of [
    "('finance','Pénzügy és pénztár'",
    "('settings','Beállítások és adminisztráció'",
    'finance.reconciliation',
    'Pénzügyi egyeztető központ',
    '/finance/reconciliation',
    'finance.transaction_trace',
    'Tranzakció-életút',
    '/finance/transaction-trace',
    'settings.system_health',
    'Rendszerállapot',
    '/admin/system-health',
    "m.code IN('finance','finance.reconciliation','finance.transaction_trace','settings','settings.system_health')",
    'clearShortCache("menu:")',
  ]) assert.ok(src.includes(marker),marker);
  assert.match(src,/VALUES\('admin'\),\('manager'\)/);
});

test('AI Exception CAPA workqueue Major Incident and Resilience executive menus self-heal analytics parent with management permissions',()=>{
  const src=read('src/services/executiveAiMenu.ts');
  for(const marker of [
    "VALUES('analytics','Statisztika és VIR'",
    'analytics.executive_ai','AI vezetői asszisztens','/finance/executive-ai',
    'analytics.exception_center','Exception Command Center','/finance/exception-command-center',
    'analytics.exception_intelligence','Exception Intelligence','/finance/exception-command-center/intelligence',
    'analytics.exception_capa','CAPA központ','/finance/exception-command-center/capa',
    'analytics.exception_capa_workqueue','CAPA vezetői munkasor','/finance/exception-command-center/capa/workqueue',
    'analytics.major_incident','Major Incident / War Room','/finance/exception-command-center/major-incidents',
    'analytics.resilience_recovery','Resilience & Recovery','/finance/exception-command-center/resilience',
    "m.code IN('analytics','analytics.executive_ai','analytics.exception_center','analytics.exception_intelligence','analytics.exception_capa','analytics.exception_capa_workqueue','analytics.major_incident','analytics.resilience_recovery')",
    'clearShortCache("menu:")',
  ]) assert.ok(src.includes(marker),marker);
  assert.match(src,/VALUES\('admin'\),\('manager'\)/);
});

test('critical menu bootstrap retries after database startup',()=>{
  const route=read('src/routes/businessReconciliation.ts');
  assert.match(route,/ensureBusinessControlMenu/);
  assert.match(route,/ensureExecutiveAiMenu/);
  for(const delay of ['0','5_000','20_000','60_000'])assert.ok(route.includes(delay));
});