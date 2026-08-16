#!/usr/bin/env node
/*
 * Destructive-safe SaaS tenant isolation UAT.
 * Runs only when SAAS_UAT_DATABASE_URL is explicitly provided and rolls back
 * every seeded record. It proves that two tenants can own similarly shaped
 * data without cross-tenant visibility through tenant-scoped predicates.
 */
const { Client } = require('pg');
const crypto = require('node:crypto');
const url = process.env.SAAS_UAT_DATABASE_URL;
if (!url) { console.log('[SAAS UAT] SKIP: SAAS_UAT_DATABASE_URL is not configured.'); process.exit(0); }
const assert = (condition, message) => { if (!condition) throw new Error(`[SAAS UAT] ${message}`); };
(async () => {
  const db = new Client({ connectionString: url, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  await db.connect(); const run = crypto.randomUUID().slice(0, 8);
  try {
    await db.query('BEGIN');
    for (const table of ['tenants','locations','clients','employees']) { const exists=await db.query(`SELECT to_regclass('public.${table}') IS NOT NULL ok`); assert(exists.rows[0]?.ok,`required table missing: ${table}`); }
    const tenantA=(await db.query(`INSERT INTO tenants(slug,name,status) VALUES($1,$2,'active') RETURNING id::text`,[`uat-a-${run}`,`UAT Tenant A ${run}`])).rows[0].id;
    const tenantB=(await db.query(`INSERT INTO tenants(slug,name,status) VALUES($1,$2,'active') RETURNING id::text`,[`uat-b-${run}`,`UAT Tenant B ${run}`])).rows[0].id;
    const locationColumns=await db.query(`SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='locations'`); const lcols=new Map(locationColumns.rows.map(r=>[r.column_name,r])); assert(lcols.has('tenant_id'),'locations.tenant_id missing');
    const idType=lcols.get('id')?.udt_name; const locationAId=idType==='uuid'?crypto.randomUUID():null; const locationBId=idType==='uuid'?crypto.randomUUID():null;
    const insertLocation=async(tenantId,name,forcedId)=>{if(forcedId)return(await db.query(`INSERT INTO locations(id,name,tenant_id) VALUES($1::uuid,$2,$3::bigint) RETURNING id::text`,[forcedId,name,tenantId])).rows[0].id;return(await db.query(`INSERT INTO locations(name,tenant_id) VALUES($1,$2::bigint) RETURNING id::text`,[name,tenantId])).rows[0].id;};
    const locationA=await insertLocation(tenantA,`UAT A ${run}`,locationAId); const locationB=await insertLocation(tenantB,`UAT B ${run}`,locationBId);
    const clientCols=new Set((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='clients'`)).rows.map(r=>r.column_name)); assert(clientCols.has('tenant_id')&&clientCols.has('location_id'),'clients tenant/location columns missing');
    const clientIdType=(await db.query(`SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='id'`)).rows[0]?.udt_name; assert(clientIdType==='uuid','UAT currently expects UUID client ids');
    const clientA=crypto.randomUUID(),clientB=crypto.randomUUID(); const nameColumn=clientCols.has('full_name')?'full_name':clientCols.has('name')?'name':null; assert(nameColumn,'clients name column missing');
    await db.query(`INSERT INTO clients(id,${nameColumn},location_id,tenant_id) VALUES($1::uuid,$2,$3::uuid,$4::bigint)`,[clientA,`UAT Client A ${run}`,locationA,tenantA]); await db.query(`INSERT INTO clients(id,${nameColumn},location_id,tenant_id) VALUES($1::uuid,$2,$3::uuid,$4::bigint)`,[clientB,`UAT Client B ${run}`,locationB,tenantB]);
    const visibleA=await db.query(`SELECT id::text FROM clients WHERE tenant_id=$1::bigint ORDER BY id`,[tenantA]); const visibleB=await db.query(`SELECT id::text FROM clients WHERE tenant_id=$1::bigint ORDER BY id`,[tenantB]);
    assert(visibleA.rows.some(r=>r.id===clientA),'tenant A cannot see its own client'); assert(!visibleA.rows.some(r=>r.id===clientB),'tenant A can see tenant B client'); assert(visibleB.rows.some(r=>r.id===clientB),'tenant B cannot see its own client'); assert(!visibleB.rows.some(r=>r.id===clientA),'tenant B can see tenant A client');
    const foreignLocation=await db.query(`SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id=$2::bigint`,[locationB,tenantA]); assert(foreignLocation.rowCount===0,'tenant A accepted tenant B location'); const foreignEntity=await db.query(`SELECT 1 FROM clients WHERE id::text=$1 AND tenant_id=$2::bigint`,[clientB,tenantA]); assert(foreignEntity.rowCount===0,'tenant A accepted tenant B entity');
    console.log(JSON.stringify({ok:true,run,assertions:['tenant A sees own client','tenant A cannot see tenant B client','tenant B sees own client','tenant B cannot see tenant A client','foreign tenant location rejected','foreign tenant entity rejected']},null,2)); await db.query('ROLLBACK');
  } catch(error){await db.query('ROLLBACK').catch(()=>{});console.error(error);process.exitCode=1;} finally {await db.end();}
})();
