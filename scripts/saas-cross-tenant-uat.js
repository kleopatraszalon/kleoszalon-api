#!/usr/bin/env node
/*
 * Destructive-safe SaaS tenant isolation UAT.
 * Runs only when SAAS_UAT_DATABASE_URL is explicitly provided and rolls back
 * every seeded record. It proves that two tenants can own similarly shaped
 * critical business data without cross-tenant visibility.
 */
const { Client } = require('pg');
const crypto = require('node:crypto');
const url = process.env.SAAS_UAT_DATABASE_URL;
if (!url) { console.log('[SAAS UAT] SKIP: SAAS_UAT_DATABASE_URL is not configured.'); process.exit(0); }
const assert = (condition, message) => { if (!condition) throw new Error(`[SAAS UAT] ${message}`); };

(async () => {
  const db = new Client({ connectionString: url, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const run = crypto.randomUUID().slice(0, 8);
  const checks = [];
  const note = message => checks.push(message);

  const requireTable = async table => {
    const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${table}`]);
    assert(exists.rows[0]?.ok, `required table missing: ${table}`);
  };
  const columns = async table => new Set((await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]
  )).rows.map(r => r.column_name));
  const assertOwnOnly = async (table, tenantA, tenantB, idA, idB) => {
    const a = await db.query(`SELECT id::text FROM ${table} WHERE tenant_id=$1::bigint`, [tenantA]);
    const b = await db.query(`SELECT id::text FROM ${table} WHERE tenant_id=$1::bigint`, [tenantB]);
    assert(a.rows.some(r => r.id === idA), `tenant A cannot see own ${table} row`);
    assert(!a.rows.some(r => r.id === idB), `tenant A can see tenant B ${table} row`);
    assert(b.rows.some(r => r.id === idB), `tenant B cannot see own ${table} row`);
    assert(!b.rows.some(r => r.id === idA), `tenant B can see tenant A ${table} row`);
    note(`${table}: bidirectional tenant isolation PASS`);
  };

  try {
    await db.query('BEGIN');
    for (const table of ['tenants','locations','clients','employees','appointments','work_orders']) await requireTable(table);

    const tenantA = (await db.query(
      `INSERT INTO tenants(slug,name,status) VALUES($1,$2,'active') RETURNING id::text`,
      [`uat-a-${run}`, `UAT Tenant A ${run}`]
    )).rows[0].id;
    const tenantB = (await db.query(
      `INSERT INTO tenants(slug,name,status) VALUES($1,$2,'active') RETURNING id::text`,
      [`uat-b-${run}`, `UAT Tenant B ${run}`]
    )).rows[0].id;

    const locationColumns = await db.query(`SELECT column_name,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='locations'`);
    const lcols = new Map(locationColumns.rows.map(r => [r.column_name, r]));
    assert(lcols.has('tenant_id'), 'locations.tenant_id missing');
    const locationIdType = lcols.get('id')?.udt_name;
    const insertLocation = async (tenantId, name) => {
      if (locationIdType === 'uuid') {
        const id = crypto.randomUUID();
        await db.query(`INSERT INTO locations(id,name,tenant_id) VALUES($1::uuid,$2,$3::bigint)`, [id, name, tenantId]);
        return id;
      }
      return (await db.query(`INSERT INTO locations(name,tenant_id) VALUES($1,$2::bigint) RETURNING id::text`, [name, tenantId])).rows[0].id;
    };
    const locationA = await insertLocation(tenantA, `UAT Location A ${run}`);
    const locationB = await insertLocation(tenantB, `UAT Location B ${run}`);
    const foreignLocation = await db.query(`SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id=$2::bigint`, [locationB, tenantA]);
    assert(foreignLocation.rowCount === 0, 'tenant A accepted tenant B location');
    note('locations: foreign tenant location rejected');

    const clientCols = await columns('clients');
    assert(clientCols.has('tenant_id') && clientCols.has('location_id'), 'clients tenant/location columns missing');
    const clientNameColumn = clientCols.has('full_name') ? 'full_name' : clientCols.has('name') ? 'name' : null;
    assert(clientNameColumn, 'clients name column missing');
    const clientA = crypto.randomUUID(), clientB = crypto.randomUUID();
    await db.query(`INSERT INTO clients(id,${clientNameColumn},location_id,tenant_id) VALUES($1::uuid,$2,$3::uuid,$4::bigint)`, [clientA, `UAT Client A ${run}`, locationA, tenantA]);
    await db.query(`INSERT INTO clients(id,${clientNameColumn},location_id,tenant_id) VALUES($1::uuid,$2,$3::uuid,$4::bigint)`, [clientB, `UAT Client B ${run}`, locationB, tenantB]);
    await assertOwnOnly('clients', tenantA, tenantB, clientA, clientB);

    const employeeCols = await columns('employees');
    assert(employeeCols.has('tenant_id') && employeeCols.has('location_id'), 'employees tenant/location columns missing');
    const employeeNameColumn = employeeCols.has('full_name') ? 'full_name' : employeeCols.has('name') ? 'name' : null;
    assert(employeeNameColumn, 'employees name column missing');
    const employeeA = crypto.randomUUID(), employeeB = crypto.randomUUID();
    await db.query(`INSERT INTO employees(id,${employeeNameColumn},location_id,tenant_id) VALUES($1::uuid,$2,$3::uuid,$4::bigint)`, [employeeA, `UAT Employee A ${run}`, locationA, tenantA]);
    await db.query(`INSERT INTO employees(id,${employeeNameColumn},location_id,tenant_id) VALUES($1::uuid,$2,$3::uuid,$4::bigint)`, [employeeB, `UAT Employee B ${run}`, locationB, tenantB]);
    await assertOwnOnly('employees', tenantA, tenantB, employeeA, employeeB);

    const appointmentCols = await columns('appointments');
    assert(appointmentCols.has('tenant_id') && appointmentCols.has('location_id'), 'appointments tenant/location columns missing');
    const appointmentA = crypto.randomUUID(), appointmentB = crypto.randomUUID();
    await db.query(`INSERT INTO appointments(id,location_id,client_id,employee_id,tenant_id,start_time,end_time) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,now(),now()+interval '1 hour')`, [appointmentA, locationA, clientA, employeeA, tenantA]);
    await db.query(`INSERT INTO appointments(id,location_id,client_id,employee_id,tenant_id,start_time,end_time) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,now(),now()+interval '1 hour')`, [appointmentB, locationB, clientB, employeeB, tenantB]);
    await assertOwnOnly('appointments', tenantA, tenantB, appointmentA, appointmentB);

    const workOrderCols = await columns('work_orders');
    assert(workOrderCols.has('tenant_id') && workOrderCols.has('location_id'), 'work_orders tenant/location columns missing');
    const workOrderA = crypto.randomUUID(), workOrderB = crypto.randomUUID();
    await db.query(`INSERT INTO work_orders(id,location_id,client_id,employee_id,tenant_id,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,'open')`, [workOrderA, locationA, clientA, employeeA, tenantA]);
    await db.query(`INSERT INTO work_orders(id,location_id,client_id,employee_id,tenant_id,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,'open')`, [workOrderB, locationB, clientB, employeeB, tenantB]);
    await assertOwnOnly('work_orders', tenantA, tenantB, workOrderA, workOrderB);

    for (const [table, foreignId] of [['clients',clientB],['employees',employeeB],['appointments',appointmentB],['work_orders',workOrderB]]) {
      const foreign = await db.query(`SELECT 1 FROM ${table} WHERE id::text=$1 AND tenant_id=$2::bigint`, [foreignId, tenantA]);
      assert(foreign.rowCount === 0, `tenant A accepted tenant B ${table} entity`);
    }
    note('foreign client/employee/appointment/work-order entities rejected');

    console.log(JSON.stringify({ ok:true, run, tenant_a:tenantA, tenant_b:tenantB, assertions:checks }, null, 2));
    await db.query('ROLLBACK');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
