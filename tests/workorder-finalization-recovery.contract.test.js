const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const transactions=read('src/routes/transactions.ts');
const recovery=read('src/routes/workOrderFinalizationRecovery.ts');
const fast=read('src/routes/workOrderFinalizationFast.ts');

test('resilient workorder finalization router is mounted before legacy finalization',()=>{
  const recoveryMount=transactions.indexOf('workOrderFinalizationRecoveryRouter);');
  const legacyMount=transactions.indexOf('workOrderFinalizationRouter);',recoveryMount+1);
  assert.ok(recoveryMount>=0,'recovery router mount missing');
  assert.ok(legacyMount>recoveryMount,'legacy finalization must remain after recovery router');
});

test('fast finalization repairs partially closed legacy workorders before document delivery',()=>{
  assert.match(fast,/j\.completed_at\|\|j\.closed_at/);
  assert.match(fast,/document_status\|\|''\)===['"]completed['"]/);
  assert.match(fast,/locked_at=COALESCE\(locked_at,now\(\)\)/);
  assert.match(fast,/archived_at=COALESCE\(archived_at,now\(\)\)/);
  assert.match(fast,/repaired:true/);
});

test('recovery router owns finalize PDF and email endpoints',()=>{
  assert.match(recovery,/router\.post\('\/workorders\/:id\/finalize'/);
  assert.match(recovery,/router\.get\('\/workorders\/:id\/pdf'/);
  assert.match(recovery,/router\.post\('\/workorders\/:id\/email'/);
  assert.match(recovery,/generateAndDeliverClosedWorkOrder/);
  assert.match(recovery,/renderClosedWorkOrderPdf/);
});

test('recovery finalization avoids request-time unique index migrations and returns actionable database errors',()=>{
  assert.doesNotMatch(recovery,/CREATE UNIQUE INDEX/i);
  assert.match(recovery,/code==='23514'/);
  assert.match(recovery,/code==='57014'/);
  assert.match(recovery,/FINALIZATION_DB_ERROR/);
});
