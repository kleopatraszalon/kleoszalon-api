'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Render production smoke accepts only healthy daily-action route markers',()=>{
  const yml=read('.github/workflows/render-deploy.yml');
  assert.match(yml,/api500-daily-actions-\(\?:v1\|v2\)/);
  assert.doesNotMatch(yml,/api500-daily-actions-\(\?:v1\|v2\|empty-v1\|empty-v2\)/);
  assert.match(yml,/const dailyHealthy=/);
  assert.match(yml,/dailyHealthy/);
});
