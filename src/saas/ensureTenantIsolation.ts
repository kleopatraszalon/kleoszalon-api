import db from "../db";
import { ensureSaasCore } from "./ensureSaasCore";

let isolationPromise: Promise<void> | null = null;

export const LOCATION_SCOPED_TABLES = [
  "employees","clients","appointments","work_orders","product_stock_balances","purchase_orders",
  "timesheets","payroll_runs","payroll_settings","daily_actions","marketing_campaigns","newsletter_campaigns",
  "inventory_movements","stocktakes","warehouse_transfers","financial_transactions","finance_transactions",
  "incoming_invoices","outgoing_invoices","invoices","cashier_shifts","cash_register_movements"
] as const;

export const EMPLOYEE_SCOPED_TABLES = [
  "leave_requests","employment_contracts","employee_compensation_assignments","employee_services",
  "employee_position_assignments","employee_evaluations"
] as const;

export const PARENT_SCOPED_TABLES = [
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

export const TENANT_MASTER_TABLES = [
  "crm_tags","crm_forms","compensation_plans","financial_accounts","financial_categories","payment_methods",
  "newsletter_templates","marketing_templates","notification_templates"
] as const;

const ROUTER_CORE_TENANT_TABLES = [
  "locations","employees","clients","appointments","work_orders","product_stock_balances","purchase_orders"
] as const;

async function missingTenantId(tables: string[]): Promise<string[]> {
  if (!tables.length) return [];
  const { rows } = await db.query<{ table_name: string }>(
    `WITH expected(table_name) AS (SELECT unnest($1::text[]))
     SELECT e.table_name
       FROM expected e
       JOIN information_schema.tables t
         ON t.table_schema='public' AND t.table_name=e.table_name
       LEFT JOIN information_schema.columns c
         ON c.table_schema='public' AND c.table_name=e.table_name AND c.column_name='tenant_id'
      WHERE c.column_name IS NULL
      ORDER BY e.table_name`,
    [tables],
  );
  return rows.map((row) => row.table_name);
}

/**
 * Runtime tenant-isolation readiness check.
 *
 * The locationManagerScope middleware directly authorizes the core entity tables
 * below, so those remain fail-closed when tenant_id is missing. Older production
 * databases can however contain auxiliary finance/HR/CRM/history tables that have
 * not yet received a physical tenant_id column. Their ownership is derived by the
 * owning location/employee/client/work-order relation in the corresponding route.
 * Treating any optional auxiliary drift as a global readiness failure caused every
 * otherwise safe client read to fail before /api/clients handlers could execute.
 */
export function ensureTenantIsolation(): Promise<void> {
  if (isolationPromise) return isolationPromise;

  isolationPromise = (async () => {
    await ensureSaasCore();

    const hardExpected = Array.from(new Set(ROUTER_CORE_TENANT_TABLES));
    const softExpected = Array.from(new Set([
      ...LOCATION_SCOPED_TABLES.filter((name) => !ROUTER_CORE_TENANT_TABLES.includes(name as any)),
      ...EMPLOYEE_SCOPED_TABLES,
      ...PARENT_SCOPED_TABLES.map((item) => item.table),
      ...TENANT_MASTER_TABLES,
    ]));

    const hardMissing = await missingTenantId(hardExpected);
    if (hardMissing.length) {
      throw new Error(
        `Tenant isolation migration required. Missing tenant_id on router core entity tables: ${hardMissing.join(", ")}. Run npm run migrate before starting the API.`,
      );
    }

    const softMissing = await missingTenantId(softExpected);
    if (softMissing.length) {
      console.warn(
        `[tenant-isolation] legacy auxiliary tables still require tenant migration: ${softMissing.join(", ")}. Parent/location-scoped reads remain enabled.`,
      );
    }
  })().catch((error) => {
    isolationPromise = null;
    throw error;
  });

  return isolationPromise;
}

export default ensureTenantIsolation;
