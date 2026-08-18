'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Release Control Center is mounted behind management access',()=>{
 const tx=read('src/routes/transactions.ts');
 assert.match(tx,/import releaseControlRouter from "\.\/releaseControl"/);
 assert.match(tx,/router\.use\("\/release-control",requireManagement,releaseControlRouter\)/);
});

test('Release Control Center keeps runtime and evidence gates separate',()=>{
 const src=read('src/routes/releaseControl.ts');
 for(const marker of ['runtime.database','runtime.migrations','version.backend','integration.smtp','integration.imap','integration.nav','integration.push','integration.wallboard','integration.mobile_app','integration.webshop','infrastructure.ha'])assert.match(src,new RegExp(marker.replace('.','\\.')));
 for(const marker of ['tests.backend','build.backend','tests.frontend','build.frontend','tests.integration','tests.financial','tests.saas','tests.rbac','backup.restore','rollback.drill','hotfix.consolidation','uat.signoff','approval.production'])assert.match(src,new RegExp(marker.replace('.','\\.')));
 assert.match(src,/release_ready:blockers\.length===0/);
 assert.match(src,/decision:blockers\.length===0\?"GO":"NO-GO"/);
});

test('Release Control Center evidence is release scoped and auditable',()=>{
 const src=read('src/routes/releaseControl.ts');
 assert.match(src,/UNIQUE\(release_ref,check_key\)/);
 assert.match(src,/updated_by text/);
 assert.match(src,/updated_at timestamptz/);
 assert.match(src,/ON CONFLICT\(release_ref,check_key\) DO UPDATE/);
});

test('Release Control Center requires verified IMAP and covers customer-facing runtimes',()=>{
 const src=read('src/routes/releaseControl.ts');
 assert.match(src,/mailbox\.enabled && Boolean\(mailbox\.lastSuccessAt\) && !mailbox\.lastError/);
 assert.match(src,/daily_action_campaigns/);
 assert.match(src,/mobile_app_settings/);
 assert.match(src,/app_push_subscriptions/);
 assert.match(src,/product_groups/);
 assert.match(src,/product_categories/);
});
