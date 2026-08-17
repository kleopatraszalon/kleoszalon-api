import db from "../db";
import type { PoolClient } from "pg";
import { ensureSaasCore } from "./ensureSaasCore";

let isolationPromise: Promise<void> | null = null;

const BOOTSTRAP_STATEMENT_TIMEOUT_MS = Number(process.env.PG_BOOTSTRAP_STATEMENT_TIMEOUT_MS ?? 120000);
const BOOTSTRAP_LOCK_TIMEOUT_MS = Number(process.env.PG_BOOTSTRAP_LOCK_TIMEOUT_MS ?? 15000);
const NORMAL_STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 8000);

const LOCATION_SCOPED_TABLES = [
  "employees","clients","appointments","work_orders","product_stock_balances","purchase_orders",
  "timesheets","payroll_runs","payroll_settings","daily_actions","marketing_campaigns","newsletter_campaigns",
  "inventory_movements","stocktakes","warehouse_transfers","financial_transactions","finance_transactions",
  "incoming_invoices","outgoing_invoices","invoices","cashier_shifts","cash_register_movements"
] as const;
const EMPLOYEE_SCOPED_TABLES = ["leave_requests","employment_contracts","employee_compensation_assignments","employee_services","employee_position_assignments","employee_evaluations"] as const;
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
const TENANT_MASTER_TABLES=["crm_tags","crm_forms","compensation_plans","financial_accounts","financial_categories","payment_methods","newsletter_templates","marketing_templates","notification_templates"] as const;

async function configureBootstrapSession(client:PoolClient){
  await client.query("SELECT set_config('statement_timeout',$1,false)", [`${BOOTSTRAP_STATEMENT_TIMEOUT_MS}ms`]);
  await client.query("SELECT set_config('lock_timeout',$1,false)", [`${BOOTSTRAP_LOCK_TIMEOUT_MS}ms`]);
}
async function restoreNormalSession(client:PoolClient){
  await client.query("SELECT set_config('statement_timeout',$1,false)", [`${NORMAL_STATEMENT_TIMEOUT_MS}ms`]).catch(()=>{});
  await client.query("SELECT set_config('lock_timeout','0ms',false)").catch(()=>{});
}
async function tableExists(client:PoolClient,table:string){const r=await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,[table]);return Boolean(r.rowCount)}
async function columnExists(client:PoolClient,table:string,column:string){const r=await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,[table,column]);return Boolean(r.rowCount)}
function bootstrapWarning(label:string,error:unknown){console.warn(`[tenant-isolation] ${label} skipped:`,(error as any)?.message||error)}
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

/**
 * Makes legacy Kleopátra records tenant-aware exactly once per process.
 * Bootstrap is serialized across Render instances with a PostgreSQL advisory
 * lock and runs with a bootstrap-only timeout, so ordinary API traffic never
 * repeatedly races ALTER TABLE / CREATE INDEX operations under the 8s request
 * statement timeout.
 */
export function ensureTenantIsolation():Promise<void>{
  if(isolationPromise)return isolationPromise;
  isolationPromise=(async()=>{
    await ensureSaasCore();
    const client=await db.connect();
    let advisoryLocked=false;
    try{
      await configureBootstrapSession(client);
      await client.query("SELECT pg_advisory_lock($1,$2)",[20260816,2]);
      advisoryLocked=true;

      const tenant=await client.query(`SELECT id FROM tenants WHERE slug='kleopatra' LIMIT 1`);
      const kleopatraTenantId=tenant.rows[0]?.id;
      if(!kleopatraTenantId)throw new Error("Kleopátra tenant bootstrap hiányzik.");

      for(const table of LOCATION_SCOPED_TABLES){
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

      await bestEffort('crm_tags:indexes',async()=>{if(await tableExists(client,"crm_tags")){await client.query(`DROP INDEX IF EXISTS crm_tags_name_uq`);await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_tenant_name_uq ON crm_tags(tenant_id,(lower(name)))`)}});
      await bestEffort('crm_forms:indexes',async()=>{if(await tableExists(client,"crm_forms")){await client.query(`DROP INDEX IF EXISTS crm_forms_title_uq`);await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_tenant_title_uq ON crm_forms(tenant_id,(lower(title)))`)}});
      await bestEffort('compensation_plans:indexes',async()=>{if(await tableExists(client,"compensation_plans")&&await columnExists(client,"compensation_plans","name")){await client.query(`CREATE INDEX IF NOT EXISTS compensation_plans_tenant_name_idx ON compensation_plans(tenant_id,(lower(name)))`)}});
    }finally{
      if(advisoryLocked)await client.query("SELECT pg_advisory_unlock($1,$2)",[20260816,2]).catch(()=>{});
      await restoreNormalSession(client);
      client.release();
    }
  })().catch(error=>{isolationPromise=null;throw error});
  return isolationPromise;
}
export default ensureTenantIsolation;
