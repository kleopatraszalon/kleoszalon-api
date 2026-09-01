const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('appointment employee picker keeps tenant-owned legacy employees without location assignment',()=>{
  const src=read('src/routes/api500Hotfix.ts');
  assert.match(src,/router\.get\("\/employees"/);
  assert.match(src,/NULLIF\(to_jsonb\(e\)->>'location_id',''\) IS NULL/);
  assert.match(src,/tenant_id/);
  assert.match(src,/api500-employees-v5/);
});

test('appointment guest search is handled before the CRM-scoped clients router and accepts tenant-owned legacy guests',()=>{
  const server=read('src/server.ts');
  const hotfix=server.indexOf('app.use("/api",api500HotfixRouter)');
  const clients=server.indexOf('app.use("/api/clients",locationManagerScope("clients"),clientsRouter)');
  assert.ok(hotfix>=0,'api500 hotfix router must be mounted');
  assert.ok(clients>hotfix,'CRM-scoped clients router must follow booking search hotfix');

  const src=read('src/routes/api500Hotfix.ts');
  assert.match(src,/router\.get\("\/clients\/booking-search"/);
  assert.match(src,/NULLIF\(to_jsonb\(c\)->>'location_id',''\) IS NULL/);
  assert.match(src,/NULLIF\(to_jsonb\(c\)->>'tenant_id',''\)/);
  assert.match(src,/ILIKE \$3/);
  assert.match(src,/LIMIT 12/);
  assert.match(src,/api500-booking-client-search-v1/);
});
