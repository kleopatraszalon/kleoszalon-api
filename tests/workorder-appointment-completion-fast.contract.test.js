const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const finalizer=fs.readFileSync(path.join(root,'src/routes/workOrderFinalizationFast.ts'),'utf8');

test('fast finalizer completes the linked appointment before work-order locking',()=>{
  assert.match(finalizer,/async function completeLinkedAppointment/);
  assert.match(finalizer,/SELECT \* FROM appointments WHERE id::text=\$1 FOR UPDATE/);
  assert.match(finalizer,/UPDATE appointments SET \$\{sets\.join\(','\)\} WHERE id::text=\$1 RETURNING id/);
  assert.match(finalizer,/status='completed'/);
  assert.match(finalizer,/work_order_id=COALESCE\(work_order_id,/);
  assert.match(finalizer,/work_order_number=COALESCE\(work_order_number,/);

  const freshCall=finalizer.indexOf('const appointmentCompleted=await completeLinkedAppointment(c,wo);',finalizer.indexOf('const inventory=await consumeWorkOrderInventory'));
  const lockUpdate=finalizer.indexOf('UPDATE work_orders SET ${sets.join(\',\')} WHERE id=$1::uuid RETURNING *');
  assert.ok(freshCall>0,'fresh finalization must complete the linked appointment');
  assert.ok(lockUpdate>freshCall,'appointment completion must happen before the work-order lock/final update');
});

test('idempotent finalization does not update an appointment already completed for the same work order',()=>{
  assert.match(finalizer,/String\(current\.status\|\|''\)\.toLowerCase\(\)==='completed'/);
  assert.match(finalizer,/linkedWorkOrder===String\(wo\.id\)/);
  assert.match(finalizer,/return true;/);

  const closedBranch=finalizer.slice(finalizer.indexOf('if(alreadyClosed){'),finalizer.indexOf("if(['cancelled','no_show']"));
  assert.match(closedBranch,/completeLinkedAppointment\(c,wo\)/);
  assert.match(closedBranch,/appointment_completed:appointmentCompleted/);
});