const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const employees=read('src/routes/employees.ts');
const bookingSchema=read('src/services/bookingWorkOrder.ts');
const bookingRepair=read('src/booking/repairBookingWorkOrderStatusConstraints.ts');

test('employee list uses its query as the fast path and migrates only on schema mismatch',()=>{
  const listRoute=employees.slice(employees.indexOf('router.get(\n  "/",'));
  assert.match(listRoute,/try \{ result = await listEmployees\(includeInactive\); \}/);
  assert.match(listRoute,/HR_SCHEMA_ERROR_CODES/);
  assert.match(listRoute,/await ensureHrSchema\(\)/);
});

test('booking schema initialization is single-flight and has a lightweight readiness probe',()=>{
  assert.match(bookingSchema,/let schemaPromise:Promise<void>\|null=null/);
  assert.match(bookingSchema,/if\(schemaPromise\)return schemaPromise/);
  assert.match(bookingSchema,/to_regprocedure\('next_official_work_order_number/);
  assert.match(bookingSchema,/schemaPromise=null;throw error/);
});

test('legacy booking repair is single-flight and skips DDL when runtime objects exist',()=>{
  assert.match(bookingRepair,/let repairPromise:Promise<void>\|null=null/);
  assert.match(bookingRepair,/if\(repairPromise\)return repairPromise/);
  assert.match(bookingRepair,/trg_fill_work_order_item_line_no/);
  assert.match(bookingRepair,/to_regclass\('public.work_order_payments'\)/);
});
