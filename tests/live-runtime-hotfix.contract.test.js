const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('payroll readiness hotfix is mounted before integrated and legacy payroll routers',()=>{
  const src=read('src/server.ts');
  const hotfix=src.indexOf('app.use("/api/payroll",payrollReadinessHotfixRouter)');
  const integrated=src.indexOf('app.use("/api/payroll",payrollIntegratedRouter)');
  const legacy=src.indexOf('app.use("/api/payroll",payrollRouter)');
  assert.ok(hotfix>=0,'payroll readiness hotfix must be mounted');
  assert.ok(integrated>hotfix,'integrated payroll router must follow readiness hotfix');
  assert.ok(legacy>integrated,'legacy payroll router must follow integrated payroll router');
});

test('checklist runtime GET hotfix is mounted before legacy checklist router',()=>{
  const src=read('src/server.ts');
  const hotfix=src.indexOf('app.use("/api/checklists",checklistsRuntimeHotfixRouter)');
  const legacy=src.indexOf('app.use("/api/checklists",locationManagerScope("checklists"),checklistsRouter)');
  assert.ok(hotfix>=0,'checklist runtime hotfix must be mounted');
  assert.ok(legacy>hotfix,'legacy checklist router must follow runtime hotfix');
});

test('booking bridge reports live schema and data errors with actionable stage and code',()=>{
  const src=read('src/routes/bookingWorkOrderBridge.ts');
  assert.match(src,/error_code/);
  assert.match(src,/stage/);
  for(const code of ['42P01','42703','42804','42830','42883','22P02','23502','23503','23514','25P02','55000'])assert.match(src,new RegExp(code));
  assert.match(src,/status\(503\)/);
  assert.match(src,/SAVEPOINT \$\{sp\}/);
  assert.match(src,/ROLLBACK TO SAVEPOINT/);
  assert.match(src,/actorUuid/);
});

test('booking workorder runtime protects legacy schema, references and transaction state',()=>{
  const src=read('src/services/bookingWorkOrder.ts');
  assert.match(src,/pg_advisory_xact_lock/);
  assert.match(src,/locked_at/);
  assert.match(src,/archived_at/);
  assert.match(src,/to_jsonb\(s\)->>'promo_price'/);
  assert.match(src,/CREATE TABLE work_order_items/);
  assert.match(src,/safeReferenceId/);
  assert.match(src,/bestEffort/);
  assert.match(src,/ROLLBACK TO SAVEPOINT/);
  assert.match(src,/reference_health/);
});

test('online booking bootstrap does not create demo data',()=>{
  const src=read('src/booking/ensureOnlineBooking.ts');
  assert.doesNotMatch(src,/ensureDemoSeedOnce/);
  assert.doesNotMatch(src,/ensureWorkOrderDemoData/);
  assert.doesNotMatch(src,/ensureCentralSupplyDemoData/);
});
