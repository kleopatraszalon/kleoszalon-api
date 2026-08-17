from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"{label}: source pattern not found in {path}")
    p.write_text(s.replace(old, new, 1))


# 1) VIR customizer: parameterized node-postgres query must not contain
# multiple SQL commands.
p = Path("src/routes/virCustomizer.ts")
s = p.read_text()
start = s.index("let ready:Promise<void>|null=null;async function ensure(){")
end = s.index("\nfunction merge", start)
new = """let ready:Promise<void>|null=null;
async function ensure(){
  if(!ready){
    ready=(async()=>{
      await db.query(`CREATE TABLE IF NOT EXISTS vir_customization(id int PRIMARY KEY DEFAULT 1 CHECK(id=1),config jsonb NOT NULL DEFAULT '{}'::jsonb,updated_by text,updated_at timestamptz NOT NULL DEFAULT now())`);
      await db.query(`INSERT INTO vir_customization(id,config) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING`,[JSON.stringify(DEFAULTS)]);
      await db.query(`CREATE TABLE IF NOT EXISTS vir_customization_audit(id bigserial PRIMARY KEY,changed_at timestamptz NOT NULL DEFAULT now(),changed_by text,before_config jsonb,after_config jsonb)`);
    })().catch(err=>{ready=null;throw err});
  }
  return ready;
}
""".strip()
p.write_text(s[:start] + new + s[end:])


# 2) SaaS core: seed locations.tenant_id according to the actual legacy type.
old = """      const locationTable=await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='locations' LIMIT 1`);
      if(locationTable.rowCount){
        await client.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS tenant_id bigint`);
        await client.query(`UPDATE locations SET tenant_id=(SELECT id FROM tenants WHERE slug='kleopatra') WHERE tenant_id IS NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations(tenant_id)`);
      }

      const userTable=await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users' LIMIT 1`);
      if(userTable.rowCount){
        await client.query(`INSERT INTO tenant_users(tenant_id,user_id,tenant_role,active) SELECT (SELECT id FROM tenants WHERE slug='kleopatra'),u.id::text,CASE WHEN lower(COALESCE(u.role::text,''))='admin' THEN 'owner' ELSE 'member' END,true FROM users u ON CONFLICT(tenant_id,user_id) DO NOTHING`);
      }
"""
new = """      const locationTable=await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='locations' LIMIT 1`);
      if(locationTable.rowCount){
        await client.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS tenant_id bigint`);
        const tenantRow=await client.query(`SELECT id::text id FROM tenants WHERE slug='kleopatra' LIMIT 1`);
        const tenantId=String(tenantRow.rows[0]?.id||'');
        const typeRow=await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='locations' AND column_name='tenant_id' LIMIT 1`);
        const tenantType=String(typeRow.rows[0]?.data_type||'');
        if(tenantId){
          if(['bigint','integer','smallint','numeric'].includes(tenantType))await client.query(`UPDATE locations SET tenant_id=$1::bigint WHERE tenant_id IS NULL`,[tenantId]);
          else if(['text','character varying','character'].includes(tenantType))await client.query(`UPDATE locations SET tenant_id=$1::text WHERE tenant_id IS NULL`,[tenantId]);
          else console.warn(`[saas-core] locations.tenant_id legacy type not auto-seeded: ${tenantType||'unknown'}`);
        }
        await client.query(`CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations(tenant_id)`);
      }

      const userTable=await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users' LIMIT 1`);
      if(userTable.rowCount){
        try{await client.query(`INSERT INTO tenant_users(tenant_id,user_id,tenant_role,active) SELECT (SELECT id FROM tenants WHERE slug='kleopatra'),u.id::text,CASE WHEN lower(COALESCE(u.role::text,''))='admin' THEN 'owner' ELSE 'member' END,true FROM users u ON CONFLICT(tenant_id,user_id) DO NOTHING`)}catch(error){console.warn('[saas-core] legacy tenant_users sync skipped:',(error as any)?.message||error)}
      }
"""
replace_once("src/saas/ensureSaasCore.ts", old, new, "ensureSaasCore legacy location block")


# 3) Tenant isolation: optional legacy tables cannot abort the whole bootstrap.
old = """async function addTenantColumn(client:PoolClient,table:string){await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id bigint`);await client.query(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`)}
async function fallbackLegacy(client:PoolClient,table:string,tenantId:any){await client.query(`UPDATE ${table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`,[tenantId])}
"""
new = """function bootstrapWarning(label:string,error:unknown){console.warn(`[tenant-isolation] ${label} skipped:`,(error as any)?.message||error)}
async function bestEffort(label:string,run:()=>Promise<void>){try{await run()}catch(error){bootstrapWarning(label,error)}}
async function addTenantColumn(client:PoolClient,table:string){
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id bigint`);
  await bestEffort(`${table}:tenant-index`,()=>client.query(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`).then(()=>undefined));
}
async function fallbackLegacy(client:PoolClient,table:string,tenantId:any){
  const r=await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='tenant_id' LIMIT 1`,[table]);
  const type=String(r.rows[0]?.data_type||'');
  if(['bigint','integer','smallint','numeric'].includes(type))await client.query(`UPDATE ${table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`,[tenantId]);
  else if(['text','character varying','character'].includes(type))await client.query(`UPDATE ${table} SET tenant_id=$1::text WHERE tenant_id IS NULL`,[String(tenantId)]);
  else bootstrapWarning(`${table}:tenant-seed-type-${type||'unknown'}`,new Error('unsupported tenant_id type'));
}
"""
replace_once("src/saas/ensureTenantIsolation.ts", old, new, "tenant isolation helpers")

old = """      for(const table of LOCATION_SCOPED_TABLES){
        if(!(await tableExists(client,table)))continue;
        await addTenantColumn(client,table);
        if(await columnExists(client,table,"location_id")){
          await client.query(`UPDATE ${table} e SET tenant_id=l.tenant_id FROM locations l WHERE e.tenant_id IS NULL AND e.location_id IS NOT NULL AND e.location_id::text=l.id::text AND l.tenant_id IS NOT NULL`);
        }
        await fallbackLegacy(client,table,kleopatraTenantId);
      }

      for(const table of EMPLOYEE_SCOPED_TABLES){
        if(!(await tableExists(client,table)))continue;
        await addTenantColumn(client,table);
        if(await columnExists(client,table,"employee_id")&&await tableExists(client,"employees")){
          await client.query(`UPDATE ${table} c SET tenant_id=e.tenant_id FROM employees e WHERE c.tenant_id IS NULL AND c.employee_id::text=e.id::text AND e.tenant_id IS NOT NULL`);
        }
        await fallbackLegacy(client,table,kleopatraTenantId);
      }

      for(const child of PARENT_SCOPED_TABLES){
        if(!(await tableExists(client,child.table))||!(await tableExists(client,child.parent))||!(await columnExists(client,child.table,child.fk)))continue;
        await addTenantColumn(client,child.table);
        await client.query(`UPDATE ${child.table} c SET tenant_id=p.tenant_id FROM ${child.parent} p WHERE c.tenant_id IS NULL AND c.${child.fk}::text=p.id::text AND p.tenant_id IS NOT NULL`);
        await fallbackLegacy(client,child.table,kleopatraTenantId);
      }

      for(const table of TENANT_MASTER_TABLES){
        if(!(await tableExists(client,table)))continue;
        await addTenantColumn(client,table);
        await fallbackLegacy(client,table,kleopatraTenantId);
      }
"""
new = """      for(const table of LOCATION_SCOPED_TABLES){
        await bestEffort(`location:${table}`,async()=>{
          if(!(await tableExists(client,table)))return;
          await addTenantColumn(client,table);
          if(await columnExists(client,table,"location_id")){
            await bestEffort(`${table}:location-backfill`,()=>client.query(`UPDATE ${table} e SET tenant_id=l.tenant_id FROM locations l WHERE e.tenant_id IS NULL AND e.location_id IS NOT NULL AND e.location_id::text=l.id::text AND l.tenant_id IS NOT NULL`).then(()=>undefined));
          }
          await fallbackLegacy(client,table,kleopatraTenantId);
        });
      }

      for(const table of EMPLOYEE_SCOPED_TABLES){
        await bestEffort(`employee:${table}`,async()=>{
          if(!(await tableExists(client,table)))return;
          await addTenantColumn(client,table);
          if(await columnExists(client,table,"employee_id")&&await tableExists(client,"employees")){
            await bestEffort(`${table}:employee-backfill`,()=>client.query(`UPDATE ${table} c SET tenant_id=e.tenant_id FROM employees e WHERE c.tenant_id IS NULL AND c.employee_id::text=e.id::text AND e.tenant_id IS NOT NULL`).then(()=>undefined));
          }
          await fallbackLegacy(client,table,kleopatraTenantId);
        });
      }

      for(const child of PARENT_SCOPED_TABLES){
        await bestEffort(`parent:${child.table}`,async()=>{
          if(!(await tableExists(client,child.table))||!(await tableExists(client,child.parent))||!(await columnExists(client,child.table,child.fk)))return;
          await addTenantColumn(client,child.table);
          await bestEffort(`${child.table}:parent-backfill`,()=>client.query(`UPDATE ${child.table} c SET tenant_id=p.tenant_id FROM ${child.parent} p WHERE c.tenant_id IS NULL AND c.${child.fk}::text=p.id::text AND p.tenant_id IS NOT NULL`).then(()=>undefined));
          await fallbackLegacy(client,child.table,kleopatraTenantId);
        });
      }

      for(const table of TENANT_MASTER_TABLES){
        await bestEffort(`master:${table}`,async()=>{
          if(!(await tableExists(client,table)))return;
          await addTenantColumn(client,table);
          await fallbackLegacy(client,table,kleopatraTenantId);
        });
      }
"""
replace_once("src/saas/ensureTenantIsolation.ts", old, new, "tenant isolation loops")

old = """      if(await tableExists(client,"crm_tags")){
        await client.query(`DROP INDEX IF EXISTS crm_tags_name_uq`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_tenant_name_uq ON crm_tags(tenant_id,(lower(name)))`);
      }
      if(await tableExists(client,"crm_forms")){
        await client.query(`DROP INDEX IF EXISTS crm_forms_title_uq`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_tenant_title_uq ON crm_forms(tenant_id,(lower(title)))`);
      }
      if(await tableExists(client,"compensation_plans")&&await columnExists(client,"compensation_plans","name")){
        await client.query(`CREATE INDEX IF NOT EXISTS compensation_plans_tenant_name_idx ON compensation_plans(tenant_id,(lower(name)))`);
      }
"""
new = """      await bestEffort('crm_tags:indexes',async()=>{if(await tableExists(client,"crm_tags")){await client.query(`DROP INDEX IF EXISTS crm_tags_name_uq`);await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_tenant_name_uq ON crm_tags(tenant_id,(lower(name)))`)}});
      await bestEffort('crm_forms:indexes',async()=>{if(await tableExists(client,"crm_forms")){await client.query(`DROP INDEX IF EXISTS crm_forms_title_uq`);await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_tenant_title_uq ON crm_forms(tenant_id,(lower(title)))`)}});
      await bestEffort('compensation_plans:indexes',async()=>{if(await tableExists(client,"compensation_plans")&&await columnExists(client,"compensation_plans","name")){await client.query(`CREATE INDEX IF NOT EXISTS compensation_plans_tenant_name_idx ON compensation_plans(tenant_id,(lower(name)))`)}});
"""
replace_once("src/saas/ensureTenantIsolation.ts", old, new, "tenant isolation indexes")


# 4) Tenant runtime comparisons are type-neutral (legacy text or canonical bigint).
p = Path("src/saas/tenantAccess.ts")
s = p.read_text()
replacements = {
    "SELECT id::text id FROM locations WHERE tenant_id=$1::bigint": "SELECT id::text id FROM locations WHERE tenant_id::text=$1::text",
    "SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id=$2::bigint LIMIT 1": "SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id::text=$2::text LIMIT 1",
    "(e.tenant_id=$2::bigint OR l.tenant_id=$2::bigint)": "(e.tenant_id::text=$2::text OR l.tenant_id::text=$2::text)",
    "e.tenant_id=$2::bigint LIMIT 1": "e.tenant_id::text=$2::text LIMIT 1",
}
for old, new in replacements.items():
    if old not in s:
        raise SystemExit(f"tenantAccess pattern missing: {old}")
    s = s.replace(old, new)
p.write_text(s)


# 5) Align stale startup contracts with the current degraded-mode startup design.
p = Path("tests/startup-resilience.contract.test.js")
s = p.read_text()
old = """  assert.match(server, /error:\"db_unreachable\"/);
  assert.match(server, /else setTimeout\\(\\(\\)=>initDbDependentThings\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\),15000\\)/);
  assert.match(server, /await initDbDependentThings\\(\\);await ensureSpecParityDependencies\\(\\);startComplaintMailboxWorker\\(\\);app\\.listen/);
"""
new = """  assert.match(server, /error:\"db_unreachable\"/);
  assert.match(server, /else setTimeout\\(\\(\\)=>initDbDependentThings\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\),15000\\)/);
  const listenAt=server.indexOf(\"app.listen(PORT\");
  const initAt=server.indexOf(\"await initDbDependentThings()\");
  const parityAt=server.indexOf(\"await ensureSpecParityDependencies()\");
  assert.ok(listenAt>=0 && initAt>listenAt && parityAt>initAt);
  assert.match(server,/void\\(async\\(\\)=>\\{try\\{await initDbDependentThings\\(\\);await ensureSpecParityDependencies\\(\\);startComplaintMailboxWorker\\(\\)/);
"""
replace_once("tests/startup-resilience.contract.test.js", old, new, "startup resilience contract")

p = Path("tests/vir-spec-parity.contract.test.js")
s = p.read_text()
old = """test('server initializes parity schema before listening and exposes readiness', () => {
  const src = read('src/server.ts');
  const ensureAt = src.indexOf('await ensureSpecParityDependencies()');
  const listenAt = src.indexOf('app.listen(PORT');
  assert.ok(ensureAt >= 0 && listenAt > ensureAt);
  assert.ok(src.includes('/api/health/ready'));
  assert.ok(src.includes('startComplaintMailboxWorker()'));
});"""
new = """test('server exposes readiness and initializes parity schema after opening the degraded-mode listener', () => {
  const src = read('src/server.ts');
  const ensureAt = src.indexOf('await ensureSpecParityDependencies()');
  const listenAt = src.indexOf('app.listen(PORT');
  assert.ok(listenAt >= 0 && ensureAt > listenAt);
  assert.ok(src.includes('/api/health/ready'));
  assert.ok(src.includes('error:\"db_unreachable\"'));
  assert.ok(src.includes('startComplaintMailboxWorker()'));
});"""
replace_once("tests/vir-spec-parity.contract.test.js", old, new, "vir spec startup contract")


# 6) Permanent regression guard for the observed production failures.
Path("tests/dashboard-runtime-v2.contract.test.js").write_text(r'''const test=require('node:test');
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
''')
