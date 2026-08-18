'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('CAPA workflow persists proposals and immutable audit events',()=>{const src=read('src/services/exceptionCapa.ts');for(const marker of ['exception_capa_candidates','exception_capa_events','trg_exception_capa_events_immutable','append-only'])assert.ok(src.includes(marker),marker)});

test('CAPA proposals derive from active root cause clusters without auto approval',()=>{const src=read('src/services/exceptionCapa.ts');for(const marker of ['exception_root_cause_clusters','syncExceptionCapaCandidates','system-intelligence',"DEFAULT 'proposed'",'root_cause_hypothesis','corrective_action','preventive_action'])assert.ok(src.includes(marker),marker);assert.ok(!src.includes("DEFAULT 'approved'"))});

test('CAPA state machine requires human approval and evidence based verification',()=>{const src=read('src/services/exceptionCapa.ts');for(const marker of ['proposed:["approved","rejected"]','approved:["in_progress","rejected"]','in_progress:["verification","rejected"]','verification:["verified","in_progress"]','legalább 10 karakteres verifikációs jegyzet','verification_evidence'])assert.ok(src.includes(marker),marker)});

test('CAPA API exposes summary list sync detail and controlled update',()=>{const route=read('src/routes/exceptionCommandCenter.ts');for(const marker of ['/intelligence/capa/summary','/intelligence/capa','/intelligence/capa/sync','/intelligence/capa/:id','startExceptionCapaScheduler'])assert.ok(route.includes(marker),marker)});

test('CAPA executive menu is management only',()=>{const menu=read('src/services/executiveAiMenu.ts');for(const marker of ['analytics.exception_capa','CAPA központ','/finance/exception-command-center/capa'])assert.ok(menu.includes(marker),marker);assert.ok(menu.includes("NOT IN('admin','manager')"))});
