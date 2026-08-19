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
  const beforeLive=yml.slice(0,live);
  assert.doesNotMatch(beforeLive,/key:\"tests\.integration\",status:\"pass\"/);
  assert.match(yml.slice(integration),/key:\"tests\.integration\",status:\"pass\"/);
});
