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
  const routeStart=employees.indexOf('router.get("/",');
  const legacyRouteStart=employees.indexOf('router.get(\n  "/",');
  const listRoute=employees.slice(Math.max(routeStart,legacyRouteStart,0));
  const legacyFastPath=/if\(!paginated\).*listEmployeesLegacy\(includeInactive\)/s.test(listRoute);
  const originalFastPath=/try \{ result = await listEmployees\(includeInactive\); \}/.test(listRoute);
  assert.ok(legacyFastPath||originalFastPath,'employee list must keep a no-DDL fast path');
  assert.match(listRoute,/HR_SCHEMA_ERROR_CODES/);
  assert.match(listRoute,/await ensureHrSchema\(\)/);
  if(legacyFastPath)assert.match(listRoute,/paginated=String\(req\.query\.paginated/);
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
