import db from "../db";
import { ensureSaasCore } from "./ensureSaasCore";

let isolationPromise: Promise<void> | null = null;

const TABLES = [
  "employees",
  "clients",
  "appointments",
  "work_orders",
  "product_stock_balances",
  "purchase_orders",
] as const;

const CHILD_TABLES = [
  { table: "appointment_services", parent: "appointments", fk: "appointment_id" },
  { table: "work_order_items", parent: "work_orders", fk: "work_order_id" },
  { table: "crm_client_tags", parent: "clients", fk: "client_id" },
  { table: "crm_client_notes", parent: "clients", fk: "client_id" },
  { table: "crm_form_responses", parent: "clients", fk: "client_id" },
  { table: "crm_consent_history", parent: "clients", fk: "client_id" },
  { table: "work_shifts", parent: "employees", fk: "employee_id" },
] as const;

const TENANT_MASTER_TABLES = ["crm_tags", "crm_forms"] as const;

async function tableExists(table: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [table]
  );
  return Boolean(result.rowCount);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column]
  );
  return Boolean(result.rowCount);
}

async function addTenantColumn(table: string) {
  await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id bigint`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`);
}

/**
 * SaaS Core v2/v3 compatibility migration.
 * Adds tenant_id to business-critical tables and their child records.
 * Existing rows remain owned by the legacy Kleopátra tenant unless a location
 * or parent record provides a more specific tenant assignment.
 */
export function ensureTenantIsolation(): Promise<void> {
  if (isolationPromise) return isolationPromise;

  isolationPromise = (async () => {
    await ensureSaasCore();
    const tenant = await db.query(`SELECT id FROM tenants WHERE slug='kleopatra' LIMIT 1`);
    const kleopatraTenantId = tenant.rows[0]?.id;
    if (!kleopatraTenantId) throw new Error("Kleopátra tenant bootstrap hiányzik.");

    for (const table of TABLES) {
      if (!(await tableExists(table))) continue;
      await addTenantColumn(table);

      if (await columnExists(table, "location_id")) {
        await db.query(
          `UPDATE ${table} e
              SET tenant_id=l.tenant_id
             FROM locations l
            WHERE e.tenant_id IS NULL
              AND e.location_id IS NOT NULL
              AND e.location_id::text=l.id::text
              AND l.tenant_id IS NOT NULL`
        );
      }

      await db.query(`UPDATE ${table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`, [kleopatraTenantId]);
    }

    for (const child of CHILD_TABLES) {
      if (!(await tableExists(child.table)) || !(await tableExists(child.parent))) continue;
      await addTenantColumn(child.table);
      await db.query(
        `UPDATE ${child.table} c
            SET tenant_id=p.tenant_id
           FROM ${child.parent} p
          WHERE c.tenant_id IS NULL
            AND c.${child.fk}::text=p.id::text
            AND p.tenant_id IS NOT NULL`
      );
      await db.query(`UPDATE ${child.table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`, [kleopatraTenantId]);
    }

    for (const table of TENANT_MASTER_TABLES) {
      if (!(await tableExists(table))) continue;
      await addTenantColumn(table);
      await db.query(`UPDATE ${table} SET tenant_id=$1::bigint WHERE tenant_id IS NULL`, [kleopatraTenantId]);
    }

    // CRM master uniqueness becomes tenant-local instead of platform-global.
    if (await tableExists("crm_tags")) {
      await db.query(`DROP INDEX IF EXISTS crm_tags_name_uq`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_tenant_name_uq ON crm_tags(tenant_id,(lower(name)))`);
    }
    if (await tableExists("crm_forms")) {
      await db.query(`DROP INDEX IF EXISTS crm_forms_title_uq`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_tenant_title_uq ON crm_forms(tenant_id,(lower(title)))`);
    }
  })().catch((error) => {
    isolationPromise = null;
    throw error;
  });

  return isolationPromise;
}

export default ensureTenantIsolation;
