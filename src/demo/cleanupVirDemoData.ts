import dotenv from "dotenv";
import db from "../db";

dotenv.config();

const BATCH = "VIR-DEMO-20260821";
const DEMO_CLIENT_SOURCE = "vir-demo-20260821";
const DEMO_EMPLOYEE_EMAIL = "vir.demo.%@example.invalid";
const DEMO_LOCATION_EMAIL = "vir.demo.%@example.invalid";

async function exists(table: string) {
  const result = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return Boolean(result.rows[0]?.ok);
}

export async function cleanupVirDemoData() {
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`SELECT set_config('app.tenant_id', COALESCE((SELECT id::text FROM tenants WHERE slug='kleopatra' LIMIT 1), ''), true)`).catch(() => undefined);

    if (await exists("daily_action_campaigns"))
      await cx.query(`DELETE FROM daily_action_campaigns WHERE name LIKE 'VIR DEMO – %'`);

    if (await exists("salon_stock_requests"))
      await cx.query(`DELETE FROM salon_stock_requests WHERE note=$1`, [BATCH]);

    if (await exists("inventory_movements"))
      await cx.query(`DELETE FROM inventory_movements WHERE note=$1`, [BATCH]);

    if (await exists("product_stock_balances") && await exists("locations"))
      await cx.query(`DELETE FROM product_stock_balances b USING locations l WHERE b.location_id::text=l.id::text AND l.email LIKE $1`, [DEMO_LOCATION_EMAIL]);

    if (await exists("appointment_services") && await exists("appointments"))
      await cx.query(`DELETE FROM appointment_services s USING appointments a WHERE s.appointment_id::text=a.id::text AND a.notes LIKE $1`, [`${BATCH}:%`]);

    if (await exists("appointments"))
      await cx.query(`DELETE FROM appointments WHERE notes LIKE $1`, [`${BATCH}:%`]);

    if (await exists("loyalty_program_history") && await exists("clients"))
      await cx.query(`DELETE FROM loyalty_program_history h USING clients c WHERE h.client_id::text=c.id::text AND c.source=$1`, [DEMO_CLIENT_SOURCE]);
    if (await exists("loyalty_program_members") && await exists("clients"))
      await cx.query(`DELETE FROM loyalty_program_members m USING clients c WHERE m.client_id::text=c.id::text AND c.source=$1`, [DEMO_CLIENT_SOURCE]);

    if (await exists("crm_form_responses") && await exists("clients"))
      await cx.query(`DELETE FROM crm_form_responses r USING clients c WHERE r.client_id::text=c.id::text AND c.source=$1`, [DEMO_CLIENT_SOURCE]);
    if (await exists("crm_consent_history") && await exists("clients"))
      await cx.query(`DELETE FROM crm_consent_history h USING clients c WHERE h.client_id::text=c.id::text AND c.source=$1`, [DEMO_CLIENT_SOURCE]);
    if (await exists("crm_client_notes") && await exists("clients"))
      await cx.query(`DELETE FROM crm_client_notes n USING clients c WHERE n.client_id::text=c.id::text AND c.source=$1`, [DEMO_CLIENT_SOURCE]);
    if (await exists("crm_client_tags") && await exists("clients"))
      await cx.query(`DELETE FROM crm_client_tags t USING clients c WHERE t.client_id::text=c.id::text AND c.source=$1`, [DEMO_CLIENT_SOURCE]);

    if (await exists("leave_requests") && await exists("employees"))
      await cx.query(`DELETE FROM leave_requests r USING employees e WHERE r.employee_id::text=e.id::text AND e.email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);
    if (await exists("timesheets") && await exists("employees"))
      await cx.query(`DELETE FROM timesheets t USING employees e WHERE t.employee_id::text=e.id::text AND e.email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);
    if (await exists("employee_service_overrides") && await exists("employees"))
      await cx.query(`DELETE FROM employee_service_overrides x USING employees e WHERE x.employee_id::text=e.id::text AND e.email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);
    if (await exists("employee_position_assignments") && await exists("employees"))
      await cx.query(`DELETE FROM employee_position_assignments x USING employees e WHERE x.employee_id::text=e.id::text AND e.email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);
    if (await exists("employee_compensation_assignments") && await exists("employees"))
      await cx.query(`DELETE FROM employee_compensation_assignments x USING employees e WHERE x.employee_id::text=e.id::text AND e.email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);
    if (await exists("employment_contracts") && await exists("employees"))
      await cx.query(`DELETE FROM employment_contracts x USING employees e WHERE x.employee_id::text=e.id::text AND e.email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);

    if (await exists("clients"))
      await cx.query(`DELETE FROM clients WHERE source=$1`, [DEMO_CLIENT_SOURCE]);
    if (await exists("employees"))
      await cx.query(`DELETE FROM employees WHERE email LIKE $1`, [DEMO_EMPLOYEE_EMAIL]);

    if (await exists("crm_tags"))
      await cx.query(`DELETE FROM crm_tags WHERE lower(name)=lower('VIR TESZT')`);

    if (await exists("locations"))
      await cx.query(`DELETE FROM locations WHERE email LIKE $1`, [DEMO_LOCATION_EMAIL]);

    if (await exists("vir_demo_batches"))
      await cx.query(`DELETE FROM vir_demo_batches WHERE batch_key=$1`, [BATCH]);

    await cx.query("COMMIT");
    console.log(`${BATCH} cleanup complete.`);
  } catch (error) {
    await cx.query("ROLLBACK").catch(() => undefined);
    console.error(`${BATCH} cleanup failed:`, error);
    throw error;
  } finally {
    cx.release();
  }
}

cleanupVirDemoData()
  .then(async () => { await db.end(); process.exit(0); })
  .catch(async () => { await db.end().catch(() => undefined); process.exit(1); });
