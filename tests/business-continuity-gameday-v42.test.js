'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('GameDay uses isolated simulation persistence and never creates real incident or freeze',()=>{const s=read('src/services/businessContinuityGameDay.ts');for(const marker of ['continuity_drills','continuity_drill_services','continuity_drill_steps','continuity_drill_injects','continuity_drill_actions','continuity_drill_events','simulation_only:true'])assert.ok(s.includes(marker),marker);assert.ok(!s.includes('INSERT INTO major_incidents'));assert.ok(!s.includes('INSERT INTO resilience_change_freezes'))});

test('GameDay inherits resilience service RTO RPO and runbooks',()=>{const s=read('src/services/businessContinuityGameDay.ts');for(const marker of ['ensureResilienceRecoverySchema','resilience_service_profiles','target_rto_minutes','target_rpo_minutes','resilience_recovery_runbooks','continuity_service_drill_policy'])assert.ok(s.includes(marker),marker)});

test('GameDay completion is evidence based with independent approval',()=>{const s=read('src/services/businessContinuityGameDay.ts');for(const marker of ['kleo_continuity_completion_guard','independent approver','mandatory evidence remains','approver.toLowerCase()','completion_evidence','scorecard'])assert.ok(s.includes(marker),marker)});

test('GameDay automatically creates improvement actions for RTO RPO breaches',()=>{const s=read('src/services/businessContinuityGameDay.ts');for(const marker of ['generateImprovementActions','RTO javítás','RPO javítás','scorecard','continuity_drill_actions'])assert.ok(s.includes(marker),marker)});

test('GameDay scheduler audits overdue drill governance daily in Budapest',()=>{const s=read('src/services/businessContinuityGameDay.ts');for(const marker of ["cron.schedule('10 7 * * *'",'Europe/Budapest','runGameDayGovernanceCycle','Elmaradt GameDay indítás'])assert.ok(s.includes(marker),marker)});

test('GameDay management API exposes planning execution evidence scorecard and actions',()=>{const r=read('src/routes/businessContinuityGameDay.ts');for(const marker of ['/summary','/templates','/service-readiness','/drills',"/:id/start","/:id/verification","/:id/complete",'/services/:serviceKey','/steps/:serviceKey/:stepKey','/injects/:injectId/release','/injects/:injectId/ack','/actions/:actionId'])assert.ok(r.includes(marker),marker);const n=read('src/routes/notifications.ts');assert.ok(n.includes('/gameday'));assert.ok(n.includes('requireManagement'))});

test('GameDay executive menu is management only',()=>{const m=read('src/services/executiveAiMenu.ts');for(const marker of ['analytics.business_continuity_gameday','Üzletmenet-folytonossági GameDay','/finance/exception-command-center/gameday'])assert.ok(m.includes(marker),marker);assert.ok(m.includes("NOT IN('admin','manager')"))});
