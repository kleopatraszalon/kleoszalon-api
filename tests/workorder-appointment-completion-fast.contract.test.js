const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const finalizer=fs.readFileSync(path.join(root,'src/routes/workOrderFinalizationFast.ts'),'utf8');

test('fast finalizer completes the linked appointment before work-order locking',()=>{
  assert.match(finalizer,/async function completeLinkedAppointment/);
  assert.match(finalizer,/UPDATE appointments SET \$\{sets\.join\(','\)\} WHERE id::text=\$1 RETURNING id/);
  assert.match(finalizer,/status='completed'/);
  assert.match(finalizer,/work_order_id=COALESCE\(work_order_id,/);
  assert.match(finalizer,/work_order_number=COALESCE\(work_order_number,/);

  const freshCall=finalizer.indexOf('const appointmentCompleted=await completeLinkedAppointment(c,wo);',finalizer.indexOf('const inventory=await consumeWorkOrderInventory'));
  const lockUpdate=finalizer.indexOf('UPDATE work_orders SET ${sets.join(\',\')} WHERE id=$1::uuid RETURNING *');
  assert.ok(freshCall>0,'fresh finalization must complete the linked appointment');
  assert.ok(lockUpdate>freshCall,'appointment completion must happen before the work-order lock/final update');
});

test('completed appointment synchronization is a retry-safe no-op',()=>{
  const helper=finalizer.slice(finalizer.indexOf('async function completeLinkedAppointment'),finalizer.indexOf('async function deliverNow'));
  const readIndex=helper.indexOf('SELECT status FROM appointments WHERE id::text=$1 LIMIT 1');
  const noOpIndex=helper.indexOf("if(String(current.status||'')==='completed')return true;");
  const updateIndex=helper.indexOf('UPDATE appointments SET ${sets.join(\',\')} WHERE id::text=$1 RETURNING id');
  assert.ok(readIndex>=0,'appointment status must be read before synchronization');
  assert.ok(noOpIndex>readIndex,'completed appointments must short-circuit before UPDATE');
  assert.ok(updateIndex>noOpIndex,'UPDATE may only run for an appointment that is not completed yet');
});

test('idempotent finalization still invokes linked appointment synchronization',()=>{
  const closedBranch=finalizer.slice(finalizer.indexOf('if(alreadyClosed){'),finalizer.indexOf("if(['cancelled','no_show']"));
  assert.match(closedBranch,/completeLinkedAppointment\(c,wo\)/);
  assert.match(closedBranch,/appointment_completed:appointmentCompleted/);
});
