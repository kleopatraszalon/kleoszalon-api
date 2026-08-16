import db from "../db";
import { ensureSaasCore } from "./ensureSaasCore";

let isolationPromise: Promise<void> | null = null;

const LOCATION_SCOPED_TABLES = [
  "employees","clients","appointments","work_orders","product_stock_balances","purchase_orders",
  "timesheets","payroll_runs","payroll_settings","daily_actions","marketing_campaigns","newsletter_campaigns",
  "inventory_movements","stocktakes","warehouse_transfers","financial_transactions","finance_transactions",
  "incoming_invoices","outgoing_invoices","invoices","cashier_shifts","cash_register_movements"
] as const;

const EMPLOYEE_SCOPED_TABLES = [
  "leave_requests","employment_contracts","employee_compensation_assignments","employee_services",
  "employee_position_assignments","employee_evaluations"
] as const;

const PARENT_SCOPED_TABLES = [
  { table: "appointment_services", parent: "appointments", fk: "appointment_id" },
  { table: "work_order_items", parent: "work_orders", fk: "work_order_id" },
  { table: "work_order_commission_events", parent: "work_orders", fk: "work_order_id" },
  { table: "crm_client_tags", parent: "clients", fk: "client_id" },
  { table: "crm_client_notes", parent: "clients", fk: "client_id" },
  { table: "crm_form_responses", parent: "clients", fk: "client_id" },
  { table: "crm_consent_history", parent: "clients", fk: "client_id" },
  { table: "work_shifts", parent: "employees", fk: "employee_id" },
  { table: "payroll_run_items", parent: "payroll_runs", fk: "payroll_run_id" },
  { table: "payroll_items", parent: "payroll_runs", fk: "payroll_run_id" },
  { table: "payroll_commission_links", parent: "payroll_runs", fk: "payroll_run_id" },
  { table: "invoice_items", parent: "invoices", fk: "invoice_id" },
  { table: "financial_transaction_items", parent: "financial_transactions", fk: "transaction_id" },
  { table: "finance_transaction_items", parent: "finance_transactions", fk: "transaction_id" }
] as const;

const TENANT_MASTER_TABLES = [
  "crm_tags","crm_forms","compensation_plans","financial_accounts","financial_categories","payment_methods",
  "newsletter_templates","marketing_templates","notification_templates"
] as const;

async function tableExists(table: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,[table]);
  return Boolean(result.rowCount);
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,[table,column]);
  return Boolean(result.rowCount);
}
async function addTenantColumn(table: string) {
  await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id bigint`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`);
}
async function fallbackLegacy(table:string,tenantId:any){
  await db.query(`UPDATE ${table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`,[tenantId]);
}

/** SaaS Core tenant ownership migration. Idempotent and legacy-compatible. */
export function ensureTenantIsolation(): Promise<void> {
  if (isolationPromise) return isolationPromise;
  isolationPromise=(async()=>{
    await ensureSaasCore();
    const tenant=await db.query(`SELECT id FROM tenants WHERE slug='kleopatra' LIMIT 1`);
    const kleopatraTenantId=tenant.rows[0]?.id;
    if(!kleopatraTenantId) throw new Error("Kleopátra tenant bootstrap hiányzik.");

    for(const table of LOCATION_SCOPED_TABLES){
      if(!(await tableExists(table))) continue;
      await addTenantColumn(table);
      if(await columnExists(table,"location_id")){
        await db.query(`UPDATE ${table} e SET tenant_id=l.tenant_id FROM locations l WHERE e.tenant_id IS NULL AND e.location_id IS NOT NULL AND e.location_id::text=l.id::text AND l.tenant_id IS NOT NULL`);
      }
      await fallbackLegacy(table,kleopatraTenantId);
    }

    for(const table of EMPLOYEE_SCOPED_TABLES){
      if(!(await tableExists(table))) continue;
      await addTenantColumn(table);
      if(await columnExists(table,"employee_id") && await tableExists("employees")){
        await db.query(`UPDATE ${table} c SET tenant_id=e.tenant_id FROM employees e WHERE c.tenant_id IS NULL AND c.employee_id::text=e.id::text AND e.tenant_id IS NOT NULL`);
      }
      await fallbackLegacy(table,kleopatraTenantId);
    }

    for(const child of PARENT_SCOPED_TABLES){
      if(!(await tableExists(child.table))||!(await tableExists(child.parent))) continue;
      if(!(await columnExists(child.table,child.fk))) continue;
      await addTenantColumn(child.table);
      await db.query(`UPDATE ${child.table} c SET tenant_id=p.tenant_id FROM ${child.parent} p WHERE c.tenant_id IS NULL AND c.${child.fk}::text=p.id::text AND p.tenant_id IS NOT NULL`);
      await fallbackLegacy(child.table,kleopatraTenantId);
    }

    for(const table of TENANT_MASTER_TABLES){
      if(!(await tableExists(table))) continue;
      await addTenantColumn(table);
      await fallbackLegacy(table,kleopatraTenantId);
    }

    if(await tableExists("crm_tags")){
      await db.query(`DROP INDEX IF EXISTS crm_tags_name_uq`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_tenant_name_uq ON crm_tags(tenant_id,(lower(name)))`);
    }
    if(await tableExists("crm_forms")){
      await db.query(`DROP INDEX IF EXISTS crm_forms_title_uq`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_tenant_title_uq ON crm_forms(tenant_id,(lower(title)))`);
    }
    if(await tableExists("compensation_plans") && await columnExists("compensation_plans","name")){
      await db.query(`CREATE INDEX IF NOT EXISTS compensation_plans_tenant_name_idx ON compensation_plans(tenant_id,(lower(name)))`);
    }
  })().catch(error=>{isolationPromise=null;throw error});
  return isolationPromise;
}
export default ensureTenantIsolation;
