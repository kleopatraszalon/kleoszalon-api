const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const triggers=read('src/workorders/repairLegacyWorkOrderTriggers.ts');
const finalization=read('src/routes/workOrderFinalizationFast.ts');
const clients=read('src/routes/clients.ts');

test('legacy trigger repair is single-flight and retries after failure',()=>{
  assert.match(triggers,/let repairPromise:Promise<void>\|null=null/);
  assert.match(triggers,/if\(repairPromise\)return repairPromise/);
  assert.match(triggers,/catch\(error\)\{repairPromise=null;throw error\}/);
});

test('trigger compatibility is prepared before the finalization transaction',()=>{
  const route=finalization.indexOf("router.post('/workorders/:id/finalize'");
  const repair=finalization.indexOf('await repairLegacyWorkOrderTriggers(c)',route);
  const begin=finalization.indexOf("await c.query('BEGIN')",route);
  assert.ok(route>=0&&repair>route&&begin>repair);
});

test('failed optional CRM bootstrap uses a bounded retry cooldown',()=>{
  assert.match(clients,/CLIENT_SCHEMA_RETRY_MS = 5 \* 60 \* 1000/);
  assert.match(clients,/Date\.now\(\) < schemaRetryAt/);
  assert.match(clients,/schemaRetryAt = Date\.now\(\) \+ CLIENT_SCHEMA_RETRY_MS/);
});
