const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const documentSource=read('src/workorders/workOrderDocument.ts');
const finalizationSource=read('src/routes/workOrderFinalizationFast.ts');

test('archive lookup is compatible with uuid and legacy text work_order_id columns',()=>{
  assert.match(documentSource,/work_order_id::text=\$1 ORDER BY archived_at DESC LIMIT 1/);
  assert.doesNotMatch(documentSource,/WHERE work_order_id=\$1::uuid ORDER BY archived_at DESC LIMIT 1/);
});

test('closed workorder PDF has an emergency fallback before email delivery',()=>{
  assert.match(documentSource,/renderEmergencyClosedWorkOrderPdf/);
  assert.match(documentSource,/rich PDF failed, emergency PDF used/);
  assert.match(documentSource,/pdf_fallback:pdfFallback/);
});

test('email retry endpoint returns explicit service errors instead of forwarding a generic 500',()=>{
  const start=finalizationSource.indexOf("router.post('/workorders/:id/email'");
  assert.ok(start>=0,'email retry route missing');
  const route=finalizationSource.slice(start);
  assert.match(route,/WORKORDER_EMAIL_DELIVERY_FAILED/);
  assert.match(route,/WORKORDER_EMAIL_RETRY_FAILED/);
  assert.doesNotMatch(route,/catch\(e\)\{next\(e\)\}/);
});
