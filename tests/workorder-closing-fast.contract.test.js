const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const lifecycle=read('src/routes/workordersLifecycleHotfix.ts');
const cashier=read('src/routes/workOrderCashierFast.ts');
const finalizer=read('src/routes/workOrderFinalizationFast.ts');
const docs=read('src/workorders/workOrderDocument.ts');
const transactions=read('src/routes/transactions.ts');

test('payment lifecycle failure cannot block the financial close for legacy schema errors',()=>{
  assert.match(lifecycle,/virtual_transition:true/);
  assert.match(lifecycle,/requested==='in_progress'/);
  assert.match(cashier,/lifecycle_required:false/);
  assert.doesNotMatch(cashier,/Végleges pénzügyi zárás csak Folyamatban/);
});

test('settlement guard no longer requires in_progress but still rejects terminal workorders',()=>{
  assert.doesNotMatch(transactions,/Végleges pénzügyi zárás csak Folyamatban/);
  assert.match(transactions,/\['cancelled','no_show','completed'\]/);
});

test('finalizer creates archive and queues automatic document delivery after commit',()=>{
  assert.match(finalizer,/ensureArchiveRow/);
  assert.match(finalizer,/const docs=queueDelivery/);
  assert.match(finalizer,/generateAndDeliverClosedWorkOrder\(workOrderId,\{sendMail:true/);
  assert.match(finalizer,/pdf_ready/);
  assert.match(finalizer,/delivery_queued:true/);
  assert.match(finalizer,/status_persisted/);
});

test('PDF and email hot paths avoid request-time trigger repair and duplicate archive loading',()=>{
  const pdfRoute=finalizer.slice(finalizer.indexOf("router.get('/workorders/:id/pdf'"));
  assert.doesNotMatch(pdfRoute,/repairLegacyWorkOrderTriggers/);
  assert.doesNotMatch(finalizer,/loadWorkOrderArchive/);
  assert.match(finalizer,/WORKORDER_PDF_RETRY_FAILED/);
  assert.match(docs,/PDF_CACHE_TTL_MS/);
  assert.match(docs,/pdfRendering/);
});

test('closed workorder document has three default recipients and font fallback',()=>{
  assert.match(docs,/Birtalan\.zoltan1975@gmail\.com/i);
  assert.match(docs,/h\.n\.andrea@kleoszalon\.hu/i);
  assert.match(docs,/rebeka\.horvath@kleoszalon\.hu/i);
  assert.match(docs,/installSafeTextFallback/);
  assert.match(docs,/attachments:\[\{filename:/);
});
