const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const server=read('src/server.ts');
const hotfix=read('src/routes/workordersLifecycleHotfix.ts');

test('lifecycle hotfix is mounted before scoped and recovery workorder routers',()=>{
  const hot=server.indexOf('app.use("/api/workorders",workordersLifecycleHotfixRouter)');
  const scoped=server.indexOf('app.use("/api/workorders",workordersScopedRouter)');
  const recovery=server.indexOf('app.use("/api/workorders",workordersLiveRecovery)');
  assert.ok(hot>=0,'lifecycle hotfix mount missing');
  assert.ok(scoped>hot,'scoped workorder router must remain after lifecycle hotfix');
  assert.ok(recovery>scoped,'live recovery must remain after scoped router');
});

test('lifecycle hotfix has no request-time schema migration or workflow bootstrap',()=>{
  assert.doesNotMatch(hotfix,/ALTER\s+TABLE/i);
  assert.doesNotMatch(hotfix,/CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(hotfix,/ensureWorkOrderWorkflow/);
  assert.doesNotMatch(hotfix,/repairBookingWorkOrderStatusConstraints/);
});

test('lifecycle hotfix preserves editor role and salon scope',()=>{
  assert.match(hotfix,/hasAnyRole\(role,\['admin','receptionist','location_manager'\]\)/);
  assert.match(hotfix,/req\.user\?\.location_id/);
  assert.match(hotfix,/Másik szalon munkalapja nem módosítható/);
});

test('lifecycle hotfix only writes optional timestamps when the live column type is timestamp-compatible',()=>{
  assert.match(hotfix,/information_schema\.columns/);
  assert.match(hotfix,/timestamp with time zone/);
  assert.match(hotfix,/timestamp without time zone/);
  assert.match(hotfix,/addTimestamp\('started_at'/);
  assert.match(hotfix,/status=\$2/);
});
