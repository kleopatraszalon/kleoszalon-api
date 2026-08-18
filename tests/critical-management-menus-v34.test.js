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
    'settings.system_health',
    'Rendszerállapot',
    '/admin/system-health',
    "m.code IN('finance','finance.reconciliation','settings','settings.system_health')",
    'clearShortCache("menu:")',
  ]) assert.ok(src.includes(marker),marker);
  assert.match(src,/VALUES\('admin'\),\('manager'\)/);
});

test('AI executive menu self-heals analytics parent and management permissions',()=>{
  const src=read('src/services/executiveAiMenu.ts');
  for(const marker of [
    "VALUES('analytics','Statisztika és VIR'",
    'analytics.executive_ai',
    'AI vezetői asszisztens',
    '/finance/executive-ai',
    "m.code IN('analytics','analytics.executive_ai')",
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
