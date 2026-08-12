const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const document=read('src/workorders/workOrderDocument.ts');
const fast=read('src/routes/workOrderFinalizationFast.ts');
const clients=read('src/routes/clients.ts');

test('closed document delivery has an in-memory archive fallback',()=>{
  assert.match(document,/buildVirtualClosedWorkOrderArchive/);
  assert.match(document,/persistent archive repair failed; virtual archive fallback/);
  assert.match(document,/virtual_recovery:true/);
  assert.match(document,/if\(!table\)return buildVirtualClosedWorkOrderArchive/);
});

test('fast document routes do not fail solely because trigger repair is unavailable',()=>{
  const documentRoutes=fast.slice(fast.indexOf("router.get('/workorders/:id/pdf'"));
  assert.doesNotMatch(documentRoutes,/repairLegacyWorkOrderTriggers/);
});

test('guest client context tolerates optional legacy CRM schema failures',()=>{
  assert.match(clients,/if\(req\.method==='GET'\)/);
  assert.match(clients,/async function optionalClientRows/);
  assert.match(clients,/a\.client_id::text=\$1/);
  assert.match(clients,/to_jsonb\(e\)/);
});
