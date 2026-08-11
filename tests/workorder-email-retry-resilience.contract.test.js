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

test('missing archive is rebuilt for a genuinely closed workorder',()=>{
  assert.match(documentSource,/repairClosedWorkOrderArchive/);
  assert.match(documentSource,/FOR UPDATE/);
  assert.match(documentSource,/j\.locked_at\|\|j\.archived_at\|\|j\.completed_at\|\|j\.closed_at/);
  assert.match(documentSource,/document_status\|\|''\)===['"]completed['"]/);
  assert.match(documentSource,/financial_closed_at/);
  assert.match(documentSource,/payment_status\|\|''\)===['"]paid['"]/);
  assert.match(documentSource,/\|\|financiallyClosed/);
  assert.match(documentSource,/WHERE NOT EXISTS\(SELECT 1 FROM work_order_archive WHERE work_order_id::text=\$1\)/);
  assert.match(documentSource,/missing archive self-healed/);
  const commit=documentSource.indexOf("await c.query('COMMIT')",documentSource.indexOf('repairClosedWorkOrderArchive'));
  const hashBackfill=documentSource.indexOf('UPDATE work_orders SET archive_hash',documentSource.indexOf('repairClosedWorkOrderArchive'));
  assert.ok(commit>=0&&hashBackfill>commit,'optional archive hash backfill must run after archive commit');
});

test('archive repair supports legacy text and uuid archive foreign-key storage',()=>{
  assert.match(documentSource,/const textId=\['text','character varying','character'\]/);
  assert.match(documentSource,/const idExpr=textId\?'\$1':'\$1::uuid'/);
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
