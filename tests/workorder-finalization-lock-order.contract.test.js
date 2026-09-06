const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const fast=fs.readFileSync(path.join(root,'src/routes/workOrderFinalizationFast.ts'),'utf8');
const lifecycle=fs.readFileSync(path.join(root,'src/routes/appointmentLifecycle.ts'),'utf8');
const transactions=fs.readFileSync(path.join(root,'src/routes/transactions.ts'),'utf8');

test('finalization locks appointment before work order to match appointment lifecycle',()=>{
  const pre=fast.indexOf('SELECT appointment_id FROM work_orders');
  const apLock=fast.indexOf('SELECT id FROM appointments WHERE id::text=$1 FOR UPDATE',pre);
  const woLock=fast.indexOf('SELECT w.*,to_jsonb(w) _json FROM work_orders',apLock);
  assert.ok(pre>=0&&apLock>pre&&woLock>apLock,'finalizer must lock appointment before work order');

  const lifecycleAp=lifecycle.indexOf('SELECT * FROM appointments WHERE id=$1::uuid FOR UPDATE');
  const lifecycleWo=lifecycle.indexOf('SELECT * FROM work_orders WHERE id=$1::uuid FOR UPDATE',lifecycleAp);
  assert.ok(lifecycleAp>=0&&lifecycleWo>lifecycleAp,'appointment lifecycle lock order must remain appointment -> work order');
});

test('transient finalization lock errors fall through to recovery router',()=>{
  assert.match(fast,/\['57014','55P03','40P01'\]\.includes\(String\(e\?\.code\|\|''\)\)/);
  assert.match(fast,/transient lock\/timeout -> recovery handoff/);
  const fastMount=transactions.indexOf('workOrderFinalizationFastRouter);');
  const recoveryMount=transactions.indexOf('workOrderFinalizationRecoveryRouter);',fastMount+1);
  assert.ok(fastMount>=0&&recoveryMount>fastMount,'recovery router must be mounted after fast finalizer');
});
