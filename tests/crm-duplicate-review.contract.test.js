const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('src/routes/clientDuplicateReview.ts');
const server=read('src/server.ts');
const menu=read('src/menu/ensureMenuHealth.ts');

test('CRM duplicate review is mounted before the generic clients router',()=>{
  assert.match(server,/import clientDuplicateReviewRouter from"\.\/routes\/clientDuplicateReview"/);
  const review=server.indexOf('clientDuplicateReviewRouter');
  const generic=server.indexOf('clientsRouter',review+1);
  assert.ok(review>=0&&generic>review,'duplicate review router must be mounted before clientsRouter');
});

test('duplicate decisions are audit-preserving and never hard-delete the client',()=>{
  assert.match(route,/CREATE TABLE IF NOT EXISTS crm_duplicate_resolutions/);
  assert.match(route,/primary_snapshot jsonb/);
  assert.match(route,/duplicate_snapshot jsonb/);
  assert.match(route,/moved_records jsonb/);
  assert.match(route,/merged_into_client_id=\$1,merged_at=now\(\)/);
  assert.doesNotMatch(route,/DELETE FROM clients/i);
});

test('non-admin duplicate review is fail-closed and requires both profiles in scope',()=>{
  assert.match(route,/CRM duplikáció-kezeléshez telephely-hozzárendelés szükséges/);
  assert.match(route,/\(a\.location_id::text=\$1 AND b\.location_id::text=\$1\)/);
  assert.match(route,/primary\.location_id !== locationId \|\| duplicate\.location_id !== locationId/);
});

test('merge transfers core customer relations and recalculates loyalty',()=>{
  for(const table of ['appointments','work_orders','crm_client_notes','crm_form_responses','crm_consent_history','loyalty_program_history','booking_communications']){
    assert.match(route,new RegExp(`"${table}"`));
  }
  assert.match(route,/INSERT INTO crm_client_tags/);
  assert.match(route,/evaluateClient\(client, primaryId, "duplicate_merge"/);
});

test('approval permissions and customer menu entry are explicit',()=>{
  assert.match(route,/APPROVER_ROLES = new Set\(\["admin", "manager", "location_manager", "salon_manager"\]\)/);
  assert.match(route,/if \(!canApprove\(req\)\)/);
  assert.match(menu,/customers\.duplicate_review/);
  assert.match(menu,/Duplikációk jóváhagyása/);
  assert.match(menu,/\/modules\/customers\/duplicate-review/);
});
