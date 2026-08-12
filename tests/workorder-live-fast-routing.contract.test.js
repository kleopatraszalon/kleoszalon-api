const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const transactions=read('src/routes/transactions.ts');
const fastFinalization=read('src/routes/workOrderFinalizationFast.ts');
const fastEditor=read('src/routes/workOrderEditorFast.ts');

test('the first live PDF and email router avoids schema repair on the hot path',()=>{
  assert.ok(transactions.indexOf('workOrderFinalizationFastRouter')<transactions.indexOf('workOrderFinalizationRecoveryRouter'));
  assert.match(fastFinalization,/generateAndDeliverClosedWorkOrder\(req\.params\.id,\{sendMail:false\}\)/);
  const documentRoutes=fastFinalization.slice(fastFinalization.indexOf("router.get('/workorders/:id/pdf'"));
  assert.doesNotMatch(documentRoutes,/repairLegacyWorkOrderTriggers/);
  assert.match(documentRoutes,/WORKORDER_PDF_RETRY_FAILED/);
});

test('fast editor options isolate optional legacy catalogue query failures',()=>{
  assert.match(fastEditor,/async function optionalRows/);
  for(const label of ['employees','clients','services','products'])assert.match(fastEditor,new RegExp(`optionalRows\\('${label}'`));
  assert.match(fastEditor,/to_jsonb\(clients\)/);
  assert.match(fastEditor,/to_jsonb\(s\)/);
  assert.match(fastEditor,/to_jsonb\(p\)/);
});
