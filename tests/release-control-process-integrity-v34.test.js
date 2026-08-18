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
  for(const marker of ['business.process_integrity','Üzleti integritás','business_process_integrity_runs','__all__','blocking:true','editable:false'])assert.ok(src.includes(marker),marker);
  assert.ok(src.includes('status:passed?"pass":"fail"'));
  assert.ok(src.includes('String(row.status||"").toLowerCase()==="ok"&&exceptionCount===0'));
  assert.ok(src.includes('NO-GO: a folyamatintegritási release gate nem ellenőrizhető'));
  assert.ok(src.includes('nincs globális folyamatintegritási futás'));
});

test('backend middleware recomputes GO NO-GO and blockers after adding business integrity gates',()=>{
  const src=read('src/middleware/releaseControlProcessIntegrity.ts');
  assert.ok(src.includes('blockers=blocking.filter'));
  assert.ok(src.includes('release_ready:blockers.length===0'));
  assert.ok(src.includes('decision:blockers.length===0?"GO":"NO-GO"'));
  assert.ok(src.includes('blocking_open:blockers.length'));
  assert.ok(src.includes('process_integrity_gate'));
  assert.ok(src.includes('transaction_trace_gate'));
});
