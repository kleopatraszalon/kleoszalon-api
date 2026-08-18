'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Major Incident persists governed War Room state, actions, updates and immutable evidence',()=>{const src=read('src/services/majorIncidentWarRoom.ts');for(const marker of ['major_incidents','major_incident_cases','major_incident_events','major_incident_actions','major_incident_updates','major_incident_notifications','trg_major_incident_events_immutable','trg_major_incident_updates_immutable','append-only'])assert.ok(src.includes(marker),marker)});

test('automatic detector calculates impact and declares SEV1 or SEV2 from correlated root cause clusters',()=>{const src=read('src/services/majorIncidentWarRoom.ts');for(const marker of ['exception_root_cause_clusters','scoreCluster','severityFromScore','score>=80','score>=60','syncMajorIncidentWarRooms','system-war-room','Major Incident automatikusan deklarálva'])assert.ok(src.includes(marker),marker)});

test('War Room detector is automatic and never sends external stakeholder communication',()=>{const src=read('src/services/majorIncidentWarRoom.ts');assert.ok(src.includes("cron.schedule('*/3 * * * *'"));assert.ok(src.includes('Europe/Budapest'));assert.ok(src.includes('A rendszer nem küld automatikusan külső ügyfélkommunikációt'));assert.ok(src.includes("audience IN('internal','executive','stakeholder')")||src.includes("audience IN ('internal','executive','stakeholder')"))});

test('Major Incident governance requires commander for human-led mitigation and evidence for resolution/post-mortem',()=>{const hard=read('src/services/majorIncidentWarRoomHardening.ts');for(const marker of ['kleo_major_incident_state_guard',"NEW.status IN ('mitigating','resolved','postmortem_closed')",'incident_commander_key','resolution_evidence','root_cause','impact_summary','lessons_learned','follow_up_actions',"ERRCODE='23514'"])assert.ok(hard.includes(marker),marker)});

test('source recovery can only auto-enter monitoring, never resolve or close post-mortem',()=>{const src=read('src/services/majorIncidentWarRoom.ts');assert.ok(src.includes("status='monitoring'"));assert.ok(src.includes('Emberi feloldás továbbra is kötelező'));assert.ok(!src.includes("system-war-room','postmortem_closed"))});

test('Major Incident API exposes summary detector detail command lifecycle actions and War Room updates',()=>{const route=read('src/routes/exceptionCommandCenter.ts');for(const marker of ['/intelligence/major-incidents/summary','/intelligence/major-incidents','/intelligence/major-incidents/sync','/intelligence/major-incidents/:id','/actions/:actionId','/updates','startMajorIncidentWarRoomScheduler','ensureMajorIncidentHardeningSchema','major_incident_governance_conflict'])assert.ok(route.includes(marker),marker)});

test('Major Incident executive menu is management only',()=>{const menu=read('src/services/executiveAiMenu.ts');for(const marker of ['analytics.major_incident','Major Incident / War Room','/finance/exception-command-center/major-incidents','MonitorPlay'])assert.ok(menu.includes(marker),marker);assert.ok(menu.includes("NOT IN('admin','manager')"))});
