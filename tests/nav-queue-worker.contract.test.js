const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

const worker=read('src/nav/navQueueWorker.ts');
const route=read('src/routes/navQueueWorker.ts');
const tx=read('src/routes/transactions.ts');
const core=read('src/finance/ensureNavInvoiceCore.ts');
const lifecycle=read('src/routes/navInvoiceLifecycle.ts');
const migration=read('src/sql/20260814_NAV_QUEUE_WORKER_V2.sql');

test('NAV queue worker is durable, lock-safe and retry bounded',()=>{
  assert.match(migration,/submission_id uuid/);
  assert.match(migration,/last_error_code text/);
  assert.match(worker,/FOR UPDATE OF q SKIP LOCKED/);
  assert.match(worker,/NAV_QUEUE_MAX_ATTEMPTS/);
  assert.match(worker,/backoffSeconds/);
  assert.match(worker,/auto_submit=true/);
  assert.match(worker,/auto_refresh=true/);
  assert.match(worker,/auto_submit_test_only=false/);
  assert.match(worker,/NAV_MANAGE_UNCERTAIN/);
});

test('NAV worker remains fail-closed and live submission remains doubly gated',()=>{
  assert.match(worker,/validateNavInvoiceXmlXsd/);
  assert.match(worker,/NAV_LIVE_SUBMIT_ENABLED/);
  assert.match(worker,/NAV_TECHNICAL_LOGIN/);
  assert.match(worker,/NAV_TECHNICAL_PASSWORD/);
  assert.match(worker,/NAV_SIGNING_KEY/);
  assert.match(worker,/NAV_EXCHANGE_KEY/);
  assert.match(worker,/queryTransactionStatus/);
  assert.match(worker,/RECEIVED/);
  assert.match(worker,/PROCESSING/);
  assert.match(worker,/SAVED/);
  assert.match(worker,/DONE/);
  assert.match(worker,/ABORTED/);
});

test('NAV worker has management controls and is mounted behind invoice bootstrap',()=>{
  assert.match(route,/queue-worker\/status/);
  assert.match(route,/queue-worker\/run-now/);
  assert.match(route,/router\.put\('\/automation'/);
  assert.match(route,/queue\/:id\/retry/);
  assert.match(route,/queue\/:id\/cancel/);
  assert.match(route,/NODE_ENV!==['"]test['"]/);
  assert.match(tx,/navQueueWorkerRouter/);
  assert.match(tx,/ensureNavInvoiceReady[^\n]*navQueueWorkerRouter/);
  assert.match(core,/20260814_NAV_QUEUE_WORKER_V2\.sql/);
});

test('Only officially issued invoices can enter the automatic NAV queue',()=>{
  assert.match(lifecycle,/document_kind/);
  assert.match(lifecycle,/tax_invoice/);
  assert.match(lifecycle,/issued_at/);
  assert.match(lifecycle,/NAV_INVOICE_NOT_ISSUED/);
});
