'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('release control separates backend, frontend, operational and candidate evidence lifetimes',()=>{
  const src=read('src/routes/releaseControl.ts');
  assert.match(src,/release_control_components/);
  assert.match(src,/release_candidate_ref/);
  assert.match(src,/frontend:\$\{frontend\}/);
  assert.match(src,/OPERATIONAL_EVIDENCE_MAX_AGE_HOURS/);
  assert.match(src,/latestFrontendEvidence/);
  assert.match(src,/latestOperationalEvidence/);
  assert.match(src,/Kézi release evidence csak az aktuális backend\+frontend release candidate-hez/);
});

test('OIDC release evidence is stored in scope-appropriate namespaces',()=>{
  const src=read('src/routes/releaseControlOidc.ts');
  assert.match(src,/scope: "backend"/);
  assert.match(src,/scope: "frontend"/);
  assert.match(src,/scope: "operational"/);
  assert.match(src,/recordReleaseComponent/);
  assert.match(src,/evidenceRef = `frontend:\$\{componentRef\}`/);
  assert.match(src,/evidenceRef = "operational:backup"/);
  assert.match(src,/rule\.scope === "backend" && expectedRef/);
});
