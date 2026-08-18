'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('resilience recovery persists service RTO RPO runbooks sessions and append-only evidence',()=>{const src=read('src/services/resilienceRecoveryControl.ts');for(const marker of ['resilience_service_profiles','rto_minutes','rpo_minutes','resilience_recovery_runbooks','resilience_recovery_sessions','resilience_recovery_service_state','resilience_recovery_step_runs','resilience_recovery_events','trg_kleo_resilience_event_immutable','append-only'])assert.ok(src.includes(marker),marker)});

test('SEV1 SEV2 recovery automatically opens change freeze and three-minute sync',()=>{const src=read('src/services/resilienceRecoveryControl.ts');for(const marker of ['resilience_change_freezes',"severity IN('sev1','sev2')",'syncResilienceRecoveryControl',"cron.schedule('*/3 * * * *'",'Europe/Budapest','shouldFreeze'])assert.ok(src.includes(marker),marker)});

test('recovery service mapping includes booking and management summary counts unique sessions and freezes',()=>{const src=read('src/services/resilienceRecoveryControl.ts');for(const marker of ['booking:["vir-core","postgresql","booking"]','appointments:["vir-core","postgresql","booking"]','COUNT(DISTINCT rs.id)','COUNT(DISTINCT cf.id)'])assert.ok(src.includes(marker),marker)});

test('emergency change override uses exact release ref expiry and two-person approval',()=>{const src=read('src/services/resilienceRecoveryControl.ts'),hard=read('src/services/resilienceRecoveryHardening.ts');for(const marker of ['resilience_emergency_change_overrides','release_ref','requested_by','approved_by','expires_at','requestEmergencyChangeOverride','decideEmergencyChangeOverride','A kérelmező nem hagyhatja jóvá'])assert.ok(src.includes(marker),marker);for(const marker of ['independent second-person approval',"interval '2 hours'",'Incident commander is required before emergency change approval'])assert.ok(hard.includes(marker),marker)});

test('ALL CLEAR is fail closed at application and database layers',()=>{const src=read('src/services/resilienceRecoveryControl.ts'),hard=read('src/services/resilienceRecoveryHardening.ts');for(const marker of ['declareRecoveryAllClear','mandatoryOpen','unverified','openActions','ALL CLEAR','change-freeze feloldva',"['monitoring','resolved'].includes"])assert.ok(src.includes(marker),marker);for(const marker of ['kleo_resilience_all_clear_guard',"incident_status NOT IN ('monitoring','resolved')",'mandatory recovery work remains','trg_kleo_resilience_freeze_reactivation_guard','nem aktiválható újra'])assert.ok(hard.includes(marker),marker)});

test('resilience management API exposes summary sessions runbooks services all clear and override decisions',()=>{const route=read('src/routes/exceptionCommandCenter.ts');for(const marker of ['/intelligence/resilience/summary','/intelligence/resilience/sessions','/intelligence/resilience/sync','/intelligence/resilience/services','/services/:serviceKey','/steps/:serviceKey/:stepKey','/all-clear','/freezes/:freezeId/overrides','/decision','startResilienceRecoveryScheduler'])assert.ok(route.includes(marker),marker)});

test('release control includes blocking resilience recovery exact-SHA gate',()=>{const gate=read('src/middleware/releaseControlResilience.ts'),main=read('src/middleware/releaseControlProcessIntegrity.ts');for(const marker of ['business.resilience_recovery','Resilience & Recovery / change-freeze','uncovered_freezes','release_ref','exact-SHA','blocking:true'])assert.ok(gate.includes(marker),marker);assert.ok(main.includes('buildResilienceRecoveryReleaseGate()'));assert.ok(main.includes('resilience_recovery_gate'))});

test('resilience executive menu remains management only',()=>{const menu=read('src/services/executiveAiMenu.ts');for(const marker of ['analytics.resilience_recovery','Resilience & Recovery','/finance/exception-command-center/resilience'])assert.ok(menu.includes(marker),marker);assert.ok(menu.includes("NOT IN('admin','manager')"))});
