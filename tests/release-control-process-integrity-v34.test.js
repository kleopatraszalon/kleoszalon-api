'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Release Control mounts the process-integrity gate on the backend route',()=>{
  const tx=read('src/routes/transactions.ts');
  assert.match(tx,/import \{enforceProcessIntegrityReleaseGate\} from "\.\.\/middleware\/releaseControlProcessIntegrity"/);
  assert.match(tx,/router\.use\("\/release-control",requireManagement,enforceProcessIntegrityReleaseGate,releaseControlRouter\)/);
});

test('process-integrity release gate is mandatory and fail-closed',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  for(const marker of ['business.process_integrity','Üzleti integritás','business_process_integrity_runs','__all__','blocking: true','editable: false'])assert.ok(src.includes(marker),marker);
  assert.match(src,/status: passed \? "pass" : "fail"/);
  assert.match(src,/String\(row\.status \|\| ""\)\.toLowerCase\(\) === "ok" && exceptionCount === 0/);
  assert.match(src,/NO-GO: a folyamatintegritási release gate nem ellenőrizhető/);
  assert.match(src,/nincs globális folyamatintegritási futás/);
});

test('backend middleware recomputes GO NO-GO and blockers after adding the integrity gate',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  assert.match(src,/const blockers = blocking\.filter\(\(item: any\) => item\?\.status !== "pass"\)/);
  assert.match(src,/release_ready: blockers\.length === 0/);
  assert.match(src,/decision: blockers\.length === 0 \? "GO" : "NO-GO"/);
  assert.match(src,/blocking_open: blockers\.length/);
  assert.match(src,/process_integrity_evidence: gate\.evidence/);
});
