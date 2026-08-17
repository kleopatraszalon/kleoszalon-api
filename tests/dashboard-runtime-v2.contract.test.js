const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('VIR customizer uses separate bootstrap queries',()=>{
  const s=fs.readFileSync('src/routes/virCustomizer.ts','utf8');
  const block=s.slice(s.indexOf('async function ensure()'),s.indexOf('function merge'));
  assert.ok((block.match(/await db\.query\(/g)||[]).length>=3);
  assert.match(block,/await db\.query\(`INSERT INTO vir_customization/);
});

test('tenant runtime comparisons tolerate text and bigint legacy ids',()=>{
  const s=fs.readFileSync('src/saas/tenantAccess.ts','utf8');
  assert.match(s,/locations WHERE tenant_id::text=\$1::text/);
  assert.match(s,/tenant_id::text=\$2::text/);
  assert.match(s,/e\.tenant_id::text=\$2::text OR l\.tenant_id::text=\$2::text/);
});

test('tenant bootstrap isolates optional legacy table failures',()=>{
  const s=fs.readFileSync('src/saas/ensureTenantIsolation.ts','utf8');
  assert.match(s,/async function bestEffort/);
  assert.match(s,/await bestEffort\(`location:\$\{table\}`/);
  assert.match(s,/await bestEffort\(`parent:\$\{child\.table\}`/);
});

test('schema-tolerant hotfix routes intercept employees and timetable before standard routers',()=>{
  const hotfix=fs.readFileSync('src/routes/api500Hotfix.ts','utf8');
  assert.match(hotfix,/router\.get\(\s*"\/employees"/);
  assert.match(hotfix,/SELECT to_jsonb\(e\) AS data/);
  assert.match(hotfix,/router\.get\(\s*"\/timetable"/);
  const server=fs.readFileSync('src/server.ts','utf8');
  const h=server.indexOf('app.use("/api",api500HotfixRouter)');
  const e=server.indexOf('app.use("/api/employees"');
  const t=server.indexOf('app.use("/api/timetable"');
  assert.ok(h>=0 && e>h && t>h);
});
