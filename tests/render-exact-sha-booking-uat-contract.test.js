'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const workflow=()=>fs.readFileSync('.github/workflows/render-deploy.yml','utf8');

test('integration evidence is published only after exact-SHA production booking UAT',()=>{
  const yml=workflow();
  const exact=yml.indexOf('Verify exact backend SHA and publish non-integration evidence');
  const live=yml.indexOf('Controlled exact-SHA production booking UAT');
  const integration=yml.indexOf('Publish exact-SHA integration evidence after live UAT');
  assert.ok(exact>=0&&live>exact&&integration>live);
  assert.match(yml,/node tests\/booking_live_uat\.mjs/);

  // The first evidence payload must deliberately exclude integration PASS.
  const preUatEvidenceSection=yml.slice(exact,live);
  assert.ok(!preUatEvidenceSection.includes('tests.integration'));

  // Integration PASS may appear only in the dedicated post-UAT publication step.
  const postUatEvidenceSection=yml.slice(integration);
  assert.ok(postUatEvidenceSection.includes('tests.integration'));
  assert.ok(postUatEvidenceSection.includes('Exact-SHA Render health/readiness/WallBoard/cashier boundary'));
});
