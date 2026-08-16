'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

test('KLEO-FUN-PROC-001-AC-02 approved procurement order is auditable and cannot bypass approval',()=>{
  const workflow=read('src/routes/procurementWorkflow.ts');
  const orders=read('src/routes/purchaseOrders.ts');
  assert.match(workflow,/approval_status='approved'/);
  assert.match(workflow,/procurement_approval_events/);
  assert.match(workflow,/approved_by/);
  assert.match(orders,/status === "ordered"/);
  assert.match(orders,/\["approved","auto_approved"\]/);
  assert.match(orders,/Rendelés csak jóváhagyás után/);
});

test('KLEO-FUN-NOT-001-AC-01 notification data is scoped to the authenticated user and location',()=>{
  const src=read('src/routes/notificationsLegacy.ts');
  assert.match(src,/notificationUserKey\(req\)/);
  assert.match(src,/req\.user\?\.location_id/);
  assert.match(src,/WHERE sm\.member_key=\$1/);
  assert.match(src,/notification_read_state WHERE user_key=\$1/);
  assert.match(src,/\[notificationUserKey\(req\), req\.params\.notificationKey\]/);
});

test('KLEO-NFR-PRV-002-AC-02 newsletter audience excludes clients without active email or marketing consent',()=>{
  const src=read('src/routes/newsletters.ts');
  assert.match(src,/COALESCE\(c\.email_consent,c\.marketing_consent,false\)=true/);
  assert.match(src,/NULLIF\(c\.email,''\) IS NOT NULL/);
  assert.match(src,/const r = await audience\(c\.audience\)/);
});

test('KLEO-FUN-WO-003-AC-01 work-order finalization is transactional and business precondition failures are conflict responses',()=>{
  const src=read('src/routes/workOrderFinalization.ts');
  assert.match(src,/BEGIN/);
  assert.match(src,/ROLLBACK/);
  assert.match(src,/finalizeTransaction/);
  assert.match(src,/pénztári|kifizetett|pénzügyi|készlet|anyag|számla|fizetéshez/);
  assert.match(src,/res\.status\(409\)/);
});
